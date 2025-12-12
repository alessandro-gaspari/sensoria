import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import 'package:google_fonts/google_fonts.dart';
import 'dart:async';
import 'dart:math' as math;

import 'device_detail_screen.dart';
import '../models/sensoria_device_type.dart';
import '../providers/connected_devices_provider.dart';
import '../streaming_manager.dart';
import 'tracking_screen.dart';
import '../providers/profile_provider.dart'; // <--- IMPORTANTE

enum GpsSignalQuality { excellent, good, poor }

class ScannerScreen extends StatefulWidget {
  const ScannerScreen({Key? key}) : super(key: key);

  @override
  State<ScannerScreen> createState() => _ScannerScreenState();
}

class _ScannerScreenState extends State<ScannerScreen> with TickerProviderStateMixin {
  // ==================== SENSORIA VARS ====================
  List<ScanResult> _sensoriaDevices = [];
  bool _isScanning = false;
  StreamSubscription<List<ScanResult>>? _scanSubscription;
  StreamSubscription<BluetoothAdapterState>? _adapterStateSubscription;
  BluetoothAdapterState _adapterState = BluetoothAdapterState.unknown;

  // ==================== GPS VARS ====================
  StreamSubscription<Position>? _gpsSubscription;
  GpsSignalQuality _gpsQuality = GpsSignalQuality.poor;
  bool _gpsEnabled = false;

  late AnimationController _animationController;

  // ==================== HRM (COOSPO) VARS ====================
  bool _showHrmOverlay = false;
  bool _isScanningHrm = false;
  bool _isStartingTracking = false;
  List<ScanResult> _hrmDevices = [];
  BluetoothDevice? _connectedHrm;
  StreamSubscription? _hrmSubscription;
  int? _localBpm; 
  String _hrmDeviceName = '';

  @override
  void initState() {
    super.initState();
    _animationController = AnimationController(
      duration: const Duration(seconds: 3),
      vsync: this,
    );
    _initBluetooth();
    _initGPS();
  }

  // ==================== GPS LOGIC ====================
  void _initGPS() async {
    _gpsEnabled = await Geolocator.isLocationServiceEnabled();
    if (!_gpsEnabled) {
      if (mounted) setState(() => _gpsQuality = GpsSignalQuality.poor);
      return;
    }
    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
      if (mounted) setState(() => _gpsQuality = GpsSignalQuality.poor);
      return;
    }
    const locationSettings = LocationSettings(accuracy: LocationAccuracy.high, distanceFilter: 10);
    _gpsSubscription = Geolocator.getPositionStream(locationSettings: locationSettings).listen((Position position) {
      if (!mounted) return;
      setState(() {
        _gpsEnabled = true;
        if (position.accuracy < 10) {
          _gpsQuality = GpsSignalQuality.excellent;
        } else if (position.accuracy < 30) {
          _gpsQuality = GpsSignalQuality.good;
        } else {
          _gpsQuality = GpsSignalQuality.poor;
        }
      });
    });
  }

  IconData _getGpsIcon() {
    if (!_gpsEnabled) return Icons.location_disabled;
    switch (_gpsQuality) {
      case GpsSignalQuality.excellent: return Icons.gps_fixed;
      case GpsSignalQuality.good: return Icons.gps_not_fixed;
      default: return Icons.gps_off;
    }
  }

  String _getGpsText() {
    if (!_gpsEnabled) return 'GPS OFF';
    switch (_gpsQuality) {
      case GpsSignalQuality.excellent: return 'GPS OTTIMO';
      case GpsSignalQuality.good: return 'GPS BUONO';
      default: return 'GPS SCARSO';
    }
  }

  // ==================== SENSORIA LOGIC ====================
  SensoriaDeviceType _identifyDeviceType(String deviceName) {
    final nameLower = deviceName.toLowerCase();
    if (nameLower.contains('sensoria-c') || nameLower.contains('core')) return SensoriaDeviceType.core;
    if (nameLower.contains('hrm') || nameLower.contains('heart')) return SensoriaDeviceType.hrm;
    if (nameLower.contains('sock') || nameLower.contains('anklet')) return SensoriaDeviceType.sock;
    return SensoriaDeviceType.unknown;
  }

  String _getDeviceEmoji(SensoriaDeviceType type, BluetoothDevice device, ConnectedDevicesProvider provider) {
    final customIconType = provider.getDeviceIconType(device);
    if (customIconType != null) {
      switch (customIconType) {
        case 'leg': return '🦿';
        case 'foot': return '🧦';
        case 'arm': return '🦾';
      }
    }
    return '❔';
  }

  String _getDeviceTypeName(SensoriaDeviceType type) {
    switch (type) {
      case SensoriaDeviceType.core: return 'Sensoria Core';
      case SensoriaDeviceType.hrm: return 'Heart Rate Monitor';
      case SensoriaDeviceType.sock: return 'Smart Sock';
      default: return 'Dispositivo Sensoria';
    }
  }

  Color _getGpsColor() {
    switch (_gpsQuality) {
      case GpsSignalQuality.excellent: return const Color.fromRGBO(151, 201, 62, 1);
      case GpsSignalQuality.good: return const Color(0xFFFFAA00);
      case GpsSignalQuality.poor: return const Color(0xFFFF4444);
    }
  }

  void _initBluetooth() async {
    _adapterState = await FlutterBluePlus.adapterState.first;
    _adapterStateSubscription = FlutterBluePlus.adapterState.listen((state) {
      if (mounted) setState(() => _adapterState = state);
    });

    _scanSubscription = FlutterBluePlus.scanResults.listen((results) {
      if (!mounted) return;
      final devicesProvider = Provider.of<ConnectedDevicesProvider>(context, listen: false);

      setState(() {
        var scannedSensoria = results.where((result) {
          final deviceName = result.device.advName.toLowerCase();
          final platformName = result.device.platformName.toLowerCase();
          return deviceName.contains('sensoria') || platformName.contains('sensoria');
        }).toList();

        scannedSensoria = scannedSensoria.fold<List<ScanResult>>([], (list, item) {
          if (!list.any((el) => el.device.remoteId == item.device.remoteId)) {
            list.add(item);
          }
          return list;
        });

        for (var entry in devicesProvider.connectedDevices.entries) {
          final deviceId = entry.key;
          final device = entry.value;
          if (!scannedSensoria.any((sr) => sr.device.remoteId.toString() == deviceId)) {
            scannedSensoria.add(ScanResult(
              device: device,
              advertisementData: AdvertisementData(
                advName: device.platformName,
                txPowerLevel: 0,
                appearance: 0,
                connectable: true,
                manufacturerData: {},
                serviceData: {},
                serviceUuids: [],
              ),
              rssi: -50,
              timeStamp: DateTime.now(),
            ));
          }
        }
        _sensoriaDevices = scannedSensoria;
      });
    });
  }

  Future<void> _startScan() async {
    if (_adapterState != BluetoothAdapterState.on) {
      _showMessage('Attiva il Bluetooth per continuare');
      return;
    }
    if (_isScanning) return;
    setState(() {
      _isScanning = true;
      _sensoriaDevices.clear();
    });
    _animationController.repeat();
    try {
      await FlutterBluePlus.startScan(timeout: const Duration(seconds: 10), androidUsesFineLocation: true);
      await Future.delayed(const Duration(seconds: 10));
      await _stopScan();
    } catch (e) {
      _showMessage('Errore durante la scansione: $e');
      setState(() => _isScanning = false);
      _animationController.stop();
    }
  }

  Future<void> _stopScan() async {
    try {
      await FlutterBluePlus.stopScan();
    } catch (_) {}
    if (mounted) {
      setState(() => _isScanning = false);
      _animationController.stop();
      _animationController.reset();
    }
  }

  // ==================== HRM LOGIC (COOSPO) ====================
  
  Future<void> _startHrmScan() async {
    if (_adapterState != BluetoothAdapterState.on) return;
    if (_isScanningHrm) return;

    setState(() {
      _isScanningHrm = true;
      _hrmDevices.clear();
    });

    if (_isScanning) await _stopScan();

    final tempSub = FlutterBluePlus.scanResults.listen((results) {
      if (!mounted) return;
      setState(() {
        _hrmDevices = results.where((result) {
          final n = result.device.advName.toLowerCase();
          final p = result.device.platformName.toLowerCase();
          final hasService = result.advertisementData.serviceUuids.any((uuid) => uuid.toString().contains('180d'));
          
          return n.contains('coospo') || n.contains('hrm') || n.contains('polar') || 
                 n.contains('magene') || p.contains('coospo') || hasService;
        }).toList();
        
        _hrmDevices = _hrmDevices.fold<List<ScanResult>>([], (list, item) {
          if (!list.any((el) => el.device.remoteId == item.device.remoteId)) {
            list.add(item);
          }
          return list;
        });
      });
    });

    try {
      await FlutterBluePlus.startScan(timeout: const Duration(seconds: 10), withServices: [Guid("180d")]); 
      await Future.delayed(const Duration(seconds: 10));
      await FlutterBluePlus.stopScan();
    } catch (e) {
      debugPrint('Errore HRM scan: $e');
    } finally {
      tempSub.cancel();
      if (mounted) setState(() => _isScanningHrm = false);
    }
  }

  Future<void> _toggleHrmConnection(BluetoothDevice device, String name) async {
    final streamingManager = Provider.of<StreamingManager>(context, listen: false);

    if (_connectedHrm != null && _connectedHrm!.remoteId == device.remoteId) {
      await _disconnectHrm();
      return;
    }

    if (_connectedHrm != null) {
      await _disconnectHrm();
    }

    try {
      await device.connect(timeout: const Duration(seconds: 15));
      
      final services = await device.discoverServices();
      BluetoothCharacteristic? hrmChar;
      
      for (var service in services) {
        if (service.uuid.toString().toLowerCase().contains('180d')) {
          for (var char in service.characteristics) {
            if (char.uuid.toString().toLowerCase().contains('2a37') && char.properties.notify) {
              hrmChar = char;
              break;
            }
          }
        }
      }

      if (hrmChar != null) {
        await hrmChar.setNotifyValue(true);
        setState(() {
          _connectedHrm = device;
          _hrmDeviceName = name;
          _localBpm = null;
        });
        
        streamingManager.setHrmConnection(device.remoteId.toString(), name, 0);

        _hrmSubscription = hrmChar.lastValueStream.listen((value) {
          if (value.isNotEmpty) {
            final bpm = _parseHeartRate(value);
            if (bpm != null) {
              if (mounted) setState(() => _localBpm = bpm);
              streamingManager.updateHeartRate(bpm);
            }
          }
        });
        
        _showMessage("✅ Connesso a $name");
      } else {
        await device.disconnect();
        _showMessage("❌ Servizio HRM non trovato");
      }
    } catch (e) {
      _showMessage("❌ Errore connessione: $e");
    }
  }

  int? _parseHeartRate(List<int> value) {
    if (value.isEmpty) return null;
    final flags = value[0];
    final is16bit = (flags & 0x01) != 0;
    if (is16bit && value.length >= 3) return value[1] | (value[2] << 8);
    if (!is16bit && value.length >= 2) return value[1];
    return null;
  }

  Future<void> _disconnectHrm() async {
    if (_connectedHrm == null) return;
    try {
      final streamingManager = Provider.of<StreamingManager>(context, listen: false);
      
      await _hrmSubscription?.cancel();
      await _connectedHrm!.disconnect();
      
      streamingManager.clearHrmConnection();
      
      if (mounted) {
        setState(() {
          _connectedHrm = null;
          _localBpm = null;
          _hrmDeviceName = '';
        });
        _showMessage("Disconnesso da HRM");
      }
    } catch (_) {}
  }

  // ==================== UI HELPERS ====================
  void _showMessage(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          message, 
          style: GoogleFonts.barlow(
            color: Colors.black, 
            fontWeight: FontWeight.w600
          )
        ),
        backgroundColor: const Color.fromRGBO(151, 201, 62, 1),
        duration: const Duration(seconds: 2),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    );
  }

  void _navigateToDeviceScreen(BluetoothDevice device, String deviceName, SensoriaDeviceType deviceType) {
    Navigator.push(
      context,
      MaterialPageRoute(builder: (context) => DeviceDetailScreen(device: device, deviceName: deviceName, deviceType: deviceType)),
    );
  }

  // ==================== WIDGET BUILDERS ====================


  // 2. Sostituisci questo metodo intero
  Widget _buildStreamingControls(ConnectedDevicesProvider devicesProvider) {
    final streamingManager = Provider.of<StreamingManager>(context);
    final hasActiveStreams = streamingManager.streamingStatus.isNotEmpty;
    
    // Il pulsante è abilitato SOLO se:
    // 1. Non ci sono stream attivi
    // 2. Non stiamo già avviando la procedura (evita doppi click)
    final bool canStart = !hasActiveStreams && !_isStartingTracking; 

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 70),
          child: SizedBox(
            height: 56,
            width: double.infinity,
            child: ElevatedButton.icon(
              onPressed: canStart
                  ? () async {
                      // BLOCCO SUBITO IL PULSANTE
                      setState(() => _isStartingTracking = true);

                      try {
                        final manager = Provider.of<StreamingManager>(context, listen: false);
                        final profileProvider = Provider.of<ProfileProvider>(context, listen: false);
                        final activeProfile = profileProvider.activeProfile;

                        manager.startTracking();
                        
                        // Avvia streaming sensori
                        await manager.startAllStreaming(
                            devicesProvider.connectedDevices, 
                            devicesProvider.deviceNames
                        );
                        
                        // INVIO PROFILO (UNA VOLTA SOLA)
                        if (activeProfile != null) {
                          // Piccolo ritardo per stabilità socket
                          await Future.delayed(const Duration(milliseconds: 300));
                          
                          await manager.sendProfileData(
                            activeProfile.name,
                            activeProfile.age,
                            activeProfile.gender,
                            activeProfile.weight
                          );
                          debugPrint("✅ Profilo inviato (Singolo invio)");
                        }

                        if (mounted) {
                          Navigator.push(
                              context, 
                              MaterialPageRoute(builder: (context) => const TrackingScreen())
                          ).then((_) {
                            // Quando torniamo indietro dalla TrackingScreen, 
                            // riabilitiamo il pulsante
                            if (mounted) setState(() => _isStartingTracking = false);
                          });
                        }
                      } catch (e) {
                        _showMessage('❌ Errore: $e');
                        // In caso di errore, riabilita il pulsante
                        if (mounted) setState(() => _isStartingTracking = false);
                      }
                    }
                  : null,
              icon: _isStartingTracking 
                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black))
                : const Icon(Icons.play_arrow, size: 22),
              label: Text(
                _isStartingTracking ? 'AVVIO...' : 'AVVIA TRACKING',
                style: GoogleFonts.barlowCondensed(
                  fontSize: 18, 
                  fontWeight: FontWeight.bold, 
                  letterSpacing: 1.0
                ),
              ),
              // ... resto dello stile uguale ...
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.transparent,
                foregroundColor: const Color.fromRGBO(151, 201, 62, 1),
                disabledForegroundColor: Colors.grey.shade600,
                side: BorderSide(
                  color: canStart ? const Color.fromRGBO(151, 201, 62, 1) : Colors.grey.shade800,
                  width: 2,
                ),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                elevation: 0,
                shadowColor: Colors.transparent,
              ),
            ),
          ),
        ),
      ),
    );
  }


  Widget _buildHrmOverlay() {
    return TweenAnimationBuilder<double>(
      tween: Tween(begin: 0.0, end: 1.0),
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeOutBack,
      builder: (context, value, child) {
        final clampedValue = value.clamp(0.0, 1.0);
        return Transform.scale(
          scale: clampedValue,
          child: Opacity(opacity: clampedValue, child: child),
        );
      },
      child: GestureDetector(
        onTap: () => setState(() => _showHrmOverlay = false),
        child: Container(
          color: Colors.black.withOpacity(0.85),
          child: Center(
            child: GestureDetector(
              onTap: () {},
              child: Container(
                width: MediaQuery.of(context).size.width * 0.85,
                height: MediaQuery.of(context).size.height * 0.55,
                decoration: BoxDecoration(
                  color: const Color(0xFF1A1A1A),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(color: const Color.fromRGBO(151, 201, 62, 0.4), width: 1),
                  boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.5), blurRadius: 20)]
                ),
                child: Column(
                  children: [
                    const SizedBox(height: 20),
                    Text(
                      "SCANNER HRM",
                      style: GoogleFonts.barlowCondensed(
                        color: const Color.fromRGBO(151, 201, 62, 1), 
                        fontSize: 24, 
                        fontWeight: FontWeight.bold,
                        letterSpacing: 1.0
                      ),
                    ),
                    const SizedBox(height: 16),
                    
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 24),
                      child: SizedBox(
                        width: double.infinity,
                        height: 48,
                        child: ElevatedButton.icon(
                          onPressed: _isScanningHrm ? null : _startHrmScan,
                          icon: _isScanningHrm
                              ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.black))
                              : const Icon(Icons.search, color: Colors.black),
                          label: Text(
                            _isScanningHrm ? "CERCA..." : "AVVIA SCANSIONE",
                            style: GoogleFonts.barlowCondensed(
                              fontWeight: FontWeight.bold,
                              fontSize: 16,
                              letterSpacing: 1.0
                            ),
                          ),
                          style: ElevatedButton.styleFrom(
                            backgroundColor: const Color.fromRGBO(151, 201, 62, 1),
                            foregroundColor: Colors.black,
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                          ),
                        ),
                      ),
                    ),
                    
                    const SizedBox(height: 16),
                    Expanded(
                      child: _hrmDevices.isEmpty
                        ? Center(
                            child: Text(
                              _isScanningHrm ? "Ricerca in corso..." : "Nessun HRM trovato",
                              style: GoogleFonts.barlow(color: Colors.white38, fontSize: 16),
                            ),
                          )
                        : ListView.builder(
                            itemCount: _hrmDevices.length,
                            itemBuilder: (context, index) {
                              final result = _hrmDevices[index];
                              final name = result.device.advName.isNotEmpty ? result.device.advName : "Unknown HRM";
                              final isConnected = _connectedHrm?.remoteId == result.device.remoteId;

                              return AnimatedContainer(
                                duration: const Duration(milliseconds: 300),
                                margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                                decoration: BoxDecoration(
                                  color: isConnected ? const Color.fromRGBO(151, 201, 62, 0.2) : Colors.transparent,
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(
                                    color: isConnected ? const Color.fromRGBO(151, 201, 62, 1) : Colors.white10
                                  )
                                ),
                                child: InkWell(
                                  borderRadius: BorderRadius.circular(12),
                                  onTap: () => _toggleHrmConnection(result.device, name),
                                  child: Padding(
                                    padding: const EdgeInsets.all(16),
                                    child: Row(
                                      children: [
                                        const Text("❤️", style: TextStyle(fontSize: 22)),
                                        const SizedBox(width: 16),
                                        Expanded(
                                          child: Text(
                                            name,
                                            style: GoogleFonts.barlowCondensed(
                                              color: isConnected ? const Color.fromRGBO(151, 201, 62, 1) : Colors.white,
                                              fontWeight: FontWeight.bold,
                                              fontSize: 18
                                            ),
                                          ),
                                        ),
                                        if (isConnected)
                                          const Icon(Icons.check, color: Color.fromRGBO(151, 201, 62, 1))
                                      ],
                                    ),
                                  ),
                                ),
                              );
                            },
                          ),
                    )
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  @override
  void dispose() {
    _scanSubscription?.cancel();
    _adapterStateSubscription?.cancel();
    _gpsSubscription?.cancel();
    _hrmSubscription?.cancel();
    _animationController.dispose();
    FlutterBluePlus.stopScan();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final devicesProvider = Provider.of<ConnectedDevicesProvider>(context);

    return Scaffold(
      backgroundColor: Colors.black, 
      appBar: AppBar(
        backgroundColor: Colors.black,
        elevation: 0,
        title: Image.asset('assets/logo_Clean.png', height: 28),
        centerTitle: true,
      ),
      body: Stack(
        children: [
          Column(
            children: [
              // HEADER STATUS
              Container(
                margin: const EdgeInsets.all(16),
                padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 20),
                decoration: BoxDecoration(
                  color: const Color(0xFF1A1A1A),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: Colors.white10, width: 1),
                ),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Expanded(
                      child: Consumer<StreamingManager>(
                        builder: (context, manager, child) {
                          final isReady = manager.isServerReachable;
                          return Row(
                            children: [
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                                decoration: BoxDecoration(
                                  color: isReady ? const Color.fromRGBO(151, 201, 62, 0.15) : Colors.red.withOpacity(0.15),
                                  borderRadius: BorderRadius.circular(8),
                                  border: Border.all(color: isReady ? const Color.fromRGBO(151, 201, 62, 1) : Colors.red, width: 1),
                                ),
                                child: Row(
                                  children: [
                                    Icon(isReady ? Icons.cloud_done : Icons.cloud_off, size: 14, color: isReady ? const Color.fromRGBO(151, 201, 62, 1) : Colors.red),
                                    const SizedBox(width: 6),
                                    Text(
                                      isReady ? "SERVER ON" : "SERVER OFF", 
                                      style: GoogleFonts.barlowCondensed(
                                        color: isReady ? const Color.fromRGBO(151, 201, 62, 1) : Colors.red, 
                                        fontWeight: FontWeight.bold, 
                                        fontSize: 16,
                                        letterSpacing: 0.5
                                      )
                                    )
                                  ],
                                ),
                              ),
                            ],
                          );
                        },
                      ),
                    ),
                    Container(width: 1, height: 24, color: Colors.white10),
                    Expanded(
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          Icon(_getGpsIcon(), color: _getGpsColor(), size: 20),
                          const SizedBox(width: 8),
                          Text(
                            _getGpsText(), 
                            style: GoogleFonts.barlowCondensed(
                              color: _getGpsColor(), 
                              fontWeight: FontWeight.bold, 
                              fontSize: 16, 
                              letterSpacing: 0.5
                            )
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),

              // PULSANTE SCANSIONE
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: SizedBox(
                  width: double.infinity,
                  height: 56,
                  child: ElevatedButton(
                    onPressed: (_isScanning || !devicesProvider.canConnectMore) ? null : _startScan,
                    child: _isScanning
                        ? Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: const [
                              SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.5, valueColor: AlwaysStoppedAnimation<Color>(Color(0xFF000000)))),
                              SizedBox(width: 14),
                              Text('SCANSIONE IN CORSO...'),
                            ],
                          )
                        : Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              const Icon(Icons.radar, size: 22),
                              const SizedBox(width: 10),
                              Text(devicesProvider.connectedCount == 0 ? 'AVVIA SCANSIONE' : 'CONNETTI ALTRO SENSORE'),
                            ],
                          ),
                    style: ElevatedButton.styleFrom(
                      backgroundColor: const Color.fromRGBO(151, 201, 62, 1),
                      foregroundColor: const Color(0xFF000000),
                      textStyle: GoogleFonts.barlowCondensed(fontWeight: FontWeight.bold, fontSize: 16, letterSpacing: 1.0),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                    ),
                  ),
                ),
              ),

              if (devicesProvider.connectedCount > 0) ...[
                const SizedBox(height: 16),
                _buildStreamingControls(devicesProvider),
              ],
              
              if (!devicesProvider.canConnectMore) ...[
                const Padding(
                  padding: EdgeInsets.all(16),
                  child: Text('Limite massimo di 6 sensori raggiunto', style: TextStyle(color: Color(0xFFFFAA00), fontSize: 13)),
                ),
              ],
              
              const SizedBox(height: 20),

              // LISTA DEVICES
              Expanded(
                child: _sensoriaDevices.isEmpty
                  ? Center(
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          _isScanning
                              ? AnimatedBuilder(
                                  animation: _animationController,
                                  builder: (context, child) {
                                    final t = _animationController.value * 2 * math.pi;
                                    final offsetX = math.sin(t) * 8;
                                    final offsetY = math.sin(2 * t) * 8;
                                    return Transform.translate(
                                      offset: Offset(offsetX, offsetY),
                                      child: const Icon(Icons.search, size: 64, color: Color.fromRGBO(151, 201, 62, 1)),
                                    );
                                  },
                                )
                              : const Icon(Icons.bluetooth_searching, size: 64, color: Colors.white24),
                          const SizedBox(height: 20),
                          Text(
                            _isScanning ? 'Ricerca dispositivi...' : 'Nessun dispositivo trovato',
                            style: GoogleFonts.barlow(
                              color: _isScanning ? const Color.fromRGBO(151, 201, 62, 1) : Colors.white24,
                              fontSize: 16,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                          if (!_isScanning) ...[
                            const SizedBox(height: 8),
                            Text(
                              'Premi il pulsante per avviare\nla scansione', 
                              textAlign: TextAlign.center, 
                              style: GoogleFonts.barlow(color: Colors.white24, fontSize: 14)
                            ),
                          ],
                        ],
                      ),
                    )
                  : ListView.builder(
                      itemCount: _sensoriaDevices.length,
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      itemBuilder: (context, index) {
                        final result = _sensoriaDevices[index];
                        final device = result.device;
                        final name = devicesProvider.getDeviceName(device);
                        final type = _identifyDeviceType(name);
                        final typeName = _getDeviceTypeName(type);
                        final isConnected = devicesProvider.isConnected(device);
                        
                        return Container(
                          margin: const EdgeInsets.only(bottom: 12),
                          child: Material(
                            color: isConnected ? const Color(0xFF1F2E1A) : const Color(0xFF1A1A1A),
                            borderRadius: BorderRadius.circular(16),
                            child: InkWell(
                              onTap: () => _navigateToDeviceScreen(device, name, type),
                              borderRadius: BorderRadius.circular(16),
                              child: Container(
                                padding: const EdgeInsets.all(16),
                                decoration: BoxDecoration(
                                  borderRadius: BorderRadius.circular(16),
                                  border: Border.all(
                                    color: isConnected ? const Color.fromRGBO(151, 201, 62, 0.6) : Colors.white10,
                                    width: isConnected ? 2 : 1
                                  )
                                ),
                                child: Row(
                                  children: [
                                    Container(
                                      width: 48, height: 48,
                                      decoration: BoxDecoration(
                                        color: isConnected ? const Color.fromRGBO(151, 201, 62, 0.25) : Colors.white10,
                                        borderRadius: BorderRadius.circular(12)
                                      ),
                                      child: Center(child: Text(_getDeviceEmoji(type, device, devicesProvider), style: const TextStyle(fontSize: 28))),
                                    ),
                                    const SizedBox(width: 14),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          Row(
                                            children: [
                                              Expanded(
                                                child: Text(
                                                  name, 
                                                  style: GoogleFonts.barlowCondensed(
                                                    color: const Color.fromRGBO(151, 201, 62, 1), 
                                                    fontWeight: FontWeight.bold, 
                                                    fontSize: 18, 
                                                  ), 
                                                  maxLines: 1, 
                                                  overflow: TextOverflow.ellipsis
                                                ),
                                              ),
                                              if (isConnected)
                                                Container(
                                                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                                                  decoration: BoxDecoration(color: const Color.fromRGBO(151, 201, 62, 1), borderRadius: BorderRadius.circular(8)),
                                                  child: Text(
                                                    'CONNESSO', 
                                                    style: GoogleFonts.barlowCondensed(
                                                      color: Colors.black, 
                                                      fontSize: 12, 
                                                      fontWeight: FontWeight.bold
                                                    )
                                                  ),
                                                )
                                            ],
                                          ),
                                          const SizedBox(height: 4),
                                          Text(
                                            typeName, 
                                            style: GoogleFonts.barlow(
                                              color: Colors.white54, 
                                              fontSize: 13, 
                                            )
                                          ),
                                          const SizedBox(height: 4),
                                          Text(
                                            device.remoteId.toString(), 
                                            style: GoogleFonts.barlow(
                                              color: Colors.white24, 
                                              fontSize: 11
                                            )
                                          ),
                                        ],
                                      ),
                                    ),
                                    const SizedBox(width: 8),
                                    Material(
                                      color: Colors.transparent,
                                      child: InkWell(
                                        borderRadius: BorderRadius.circular(12),
                                        onTap: () async {
                                          if (isConnected) {
                                            await devicesProvider.disconnectDevice(device);
                                          } else {
                                            if (!devicesProvider.canConnectMore) {
                                              _showMessage('Massimo 6 sensori raggiunto');
                                              return;
                                            }
                                            await devicesProvider.connectDevice(device);
                                          }
                                        },
                                        child: Container(
                                          width: 44, height: 44,
                                          decoration: BoxDecoration(
                                            color: isConnected ? const Color.fromARGB(54, 255, 0, 0) : const Color.fromRGBO(151, 201, 62, 0.15),
                                            borderRadius: BorderRadius.circular(12),
                                            border: Border.all(color: isConnected ? Colors.red : const Color.fromRGBO(151, 201, 62, 0.3), width: 1)
                                          ),
                                          child: Icon(isConnected ? Icons.remove_circle_outline : Icons.link, color: isConnected ? Colors.red : const Color.fromRGBO(151, 201, 62, 1), size: 22),
                                        ),
                                      ),
                                    )
                                  ],
                                ),
                              ),
                            ),
                          ),
                        );
                      },
                    ),
              )
            ],
          ),

          Positioned(
            bottom: 30,
            right: 20,
            child: _connectedHrm != null
              ? GestureDetector(
                  onTap: () => setState(() => _showHrmOverlay = true),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                    decoration: BoxDecoration(
                      color: const Color(0xFF1A1A1A),
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: const Color.fromRGBO(151, 201, 62, 1), width: 2),
                      boxShadow: [BoxShadow(color: Colors.black.withOpacity(0.5), blurRadius: 10)],
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          "${_localBpm ?? '--'}",
                          style: GoogleFonts.barlowCondensed(
                            color: const Color.fromRGBO(151, 201, 62, 1), 
                            fontSize: 32, 
                            fontWeight: FontWeight.bold
                          ),
                        ),
                        Text(
                          "BPM", 
                          style: GoogleFonts.barlowCondensed(
                            color: Colors.white70, 
                            fontSize: 12, 
                            fontWeight: FontWeight.bold
                          )
                        )
                      ],
                    ),
                  ),
                )
              : FloatingActionButton(
                  onPressed: () => setState(() => _showHrmOverlay = true),
                  backgroundColor: Colors.transparent,
                  elevation: 0,
                  highlightElevation: 0,
                  child: const Text("❤️", style: TextStyle(fontSize: 44)),
                ),
          ),

          if (_showHrmOverlay) _buildHrmOverlay(),
        ],
      ),
    );
  }
}
