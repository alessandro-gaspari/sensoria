import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:geolocator/geolocator.dart';
import 'package:provider/provider.dart';
import 'dart:async';
import 'dart:math' as math;
import 'device_detail_screen.dart';
import '../models/sensoria_device_type.dart';
import '../providers/connected_devices_provider.dart';
import '../streaming_manager.dart';
import 'tracking_screen.dart';

enum GpsSignalQuality { excellent, good, poor }

class ScannerScreen extends StatefulWidget {
  const ScannerScreen({Key? key}) : super(key: key);

  @override
  State<ScannerScreen> createState() => _ScannerScreenState();
}

class _ScannerScreenState extends State<ScannerScreen> with SingleTickerProviderStateMixin {
  List<ScanResult> _sensoriaDevices = [];
  bool _isScanning = false;
  StreamSubscription<List<ScanResult>>? _scanSubscription;
  StreamSubscription<BluetoothAdapterState>? _adapterStateSubscription;
  BluetoothAdapterState _adapterState = BluetoothAdapterState.unknown;
  
  StreamSubscription<Position>? _gpsSubscription;
  GpsSignalQuality _gpsQuality = GpsSignalQuality.poor;
  double? _gpsAccuracy;
  bool _gpsEnabled = false;
  
  late AnimationController _animationController;

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

  void _initGPS() async {
    _gpsEnabled = await Geolocator.isLocationServiceEnabled();
    if (!_gpsEnabled) {
      setState(() => _gpsQuality = GpsSignalQuality.poor);
      return;
    }
    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
      setState(() => _gpsQuality = GpsSignalQuality.poor);
      return;
    }
    const locationSettings = LocationSettings(accuracy: LocationAccuracy.high, distanceFilter: 10);
    _gpsSubscription = Geolocator.getPositionStream(locationSettings: locationSettings).listen((Position position) {
      if (mounted) {
        setState(() {
          _gpsAccuracy = position.accuracy;
          _gpsEnabled = true;
          if (position.accuracy < 10) {
            _gpsQuality = GpsSignalQuality.excellent;
          } else if (position.accuracy < 30) {
            _gpsQuality = GpsSignalQuality.good;
          } else {
            _gpsQuality = GpsSignalQuality.poor;
          }
        });
      }
    });
  }

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

  String _getGpsText() {
    if (!_gpsEnabled) return 'GPS Off';
    switch (_gpsQuality) {
      case GpsSignalQuality.excellent: return 'GPS Ottimo';
      case GpsSignalQuality.good: return 'GPS Buono';
      default: return 'GPS Scarso';
    }
  }

  IconData _getGpsIcon() {
    if (!_gpsEnabled) return Icons.location_disabled;
    switch (_gpsQuality) {
      case GpsSignalQuality.excellent: return Icons.gps_fixed;
      case GpsSignalQuality.good: return Icons.gps_not_fixed;
      default: return Icons.gps_off;
    }
  }

  void _initBluetooth() async {
    _adapterState = await FlutterBluePlus.adapterState.first;
    _adapterStateSubscription = FlutterBluePlus.adapterState.listen((state) {
      if (mounted) setState(() => _adapterState = state);
    });
    _scanSubscription = FlutterBluePlus.scanResults.listen((results) {
      if (mounted) {
        final devicesProvider = Provider.of<ConnectedDevicesProvider>(context, listen: false);
        setState(() {
          var scannedSensoria = results.where((result) {
            String deviceName = result.device.advName.toLowerCase();
            String platformName = result.device.platformName.toLowerCase();
            return deviceName.contains('sensoria') || platformName.contains('sensoria');
          }).toList();

          scannedSensoria = scannedSensoria.fold<List<ScanResult>>([], (list, item) {
            if (!list.any((element) => element.device.remoteId == item.device.remoteId)) {
              list.add(item);
            }
            return list;
          });

          // Inserisci sempre i dispositivi connessi che non sono nella scansione
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
      }
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

  void _showMessage(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message, style: const TextStyle(color: Color(0xFF000000), fontWeight: FontWeight.w500)),
        backgroundColor: const Color.fromRGBO(151, 201, 62, 1),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        duration: const Duration(seconds: 2),
      ),
    );
  }

  void _navigateToDeviceScreen(BluetoothDevice device, String deviceName, SensoriaDeviceType deviceType) {
    Navigator.push(
      context,
      MaterialPageRoute(builder: (context) => DeviceDetailScreen(device: device, deviceName: deviceName, deviceType: deviceType)),
    );
  }

  Widget _buildStreamingControls(ConnectedDevicesProvider devicesProvider) {
  final streamingManager = Provider.of<StreamingManager>(context);
  final hasActiveStreams = streamingManager.streamingStatus.isNotEmpty;

  return Padding(
    padding: const EdgeInsets.symmetric(horizontal: 16),
    child: Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 70),
        child: SizedBox(
          height: 56,
          width: double.infinity,
          child: ElevatedButton.icon(
            onPressed: hasActiveStreams
              ? null
              : () async {
                  try {
                    final streamingManager = Provider.of<StreamingManager>(context, listen: false);

                    // ✅ AVVIA TRACKING (salvataggio SSH)
                    streamingManager.startTracking();
                    
                    // ✅ AVVIA STREAMING (dati a Render + sensori live)
                    await streamingManager.startAllStreaming(
                      devicesProvider.connectedDevices,
                      devicesProvider.deviceNames,
                    );

                    if (mounted) {
                      Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (context) => const TrackingScreen(),
                        ),
                      );
                    }
                  } catch (e) {
                    _showMessage('❌ Errore: $e');
                  }
                },
            icon: const Icon(Icons.play_arrow, size: 22),
            label: const Text(
              'AVVIA TRACKING',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.5,
                color: Color.fromRGBO(151, 201, 62, 1),
              ),
            ),
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.transparent,
              foregroundColor: const Color.fromRGBO(151, 201, 62, 1),
              side: const BorderSide(
                color: Color.fromRGBO(151, 201, 62, 1),
                width: 2,
              ),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              elevation: 0,
              shadowColor: Colors.transparent,
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
    _animationController.dispose();
    FlutterBluePlus.stopScan();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final devicesProvider = Provider.of<ConnectedDevicesProvider>(context);

    return Scaffold(
      appBar: AppBar(
        title: Image.asset('assets/logo_Clean.png', height: 40),
        centerTitle: true,
        elevation: 0,
      ),
      body: Column(
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 20),
            margin: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: const Color(0xFF1A1A1A),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(
                color: const Color.fromRGBO(89, 89, 92, 0.3),
                width: 1,
              ),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                  child: Row(
                    children: [
                      const Icon(
                        Icons.sensors,
                        color: Color.fromRGBO(151, 201, 62, 1),
                        size: 20,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        'Sensori: ${devicesProvider.connectedCount}/6',
                        style: const TextStyle(
                          color: Color.fromRGBO(151, 201, 62, 1),
                          fontWeight: FontWeight.w600,
                          fontSize: 14,
                          letterSpacing: 0.5,
                        ),
                      ),
                    ],
                  ),
                ),
                Container(
                  width: 1,
                  height: 24,
                  color: const Color.fromRGBO(89, 89, 92, 0.3),
                ),
                Expanded(
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      Icon(
                        _getGpsIcon(),
                        color: _getGpsColor(),
                        size: 20,
                      ),
                      const SizedBox(width: 8),
                      Text(
                        _getGpsText(),
                        style: TextStyle(
                          color: _getGpsColor(),
                          fontWeight: FontWeight.w600,
                          fontSize: 14,
                          letterSpacing: 0.5,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
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
                          SizedBox(
                              width: 20,
                              height: 20,
                              child: CircularProgressIndicator(
                                strokeWidth: 2.5,
                                valueColor:
                                    AlwaysStoppedAnimation<Color>(Color(0xFF000000)),
                              )),
                          SizedBox(width: 14),
                          Text('SCANSIONE IN CORSO...'),
                        ],
                      )
                    : Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          const Icon(Icons.radar, size: 22),
                          const SizedBox(width: 10),
                          Text(devicesProvider.connectedCount == 0
                              ? 'AVVIA SCANSIONE'
                              : 'CONNETTI ALTRO SENSORE'),
                        ],
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
              child: Text(
                'Limite massimo di 6 sensori raggiunto',
                style: TextStyle(color: Color(0xFFFFAA00), fontSize: 13),
              ),
            ),
          ],
          const SizedBox(height: 20),
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
                                    child: const Icon(
                                      Icons.search,
                                      size: 64,
                                      color: Color.fromRGBO(151, 201, 62, 1),
                                    ),
                                  );
                                },
                              )
                            : const Icon(Icons.bluetooth_searching,
                                size: 64, color: Color.fromRGBO(89, 89, 92, 0.5)),
                        const SizedBox(height: 20),
                        Text(
                          _isScanning ? 'Ricerca dispositivi...' : 'Nessun dispositivo trovato',
                          style: TextStyle(
                            color: _isScanning
                                ? const Color.fromRGBO(151, 201, 62, 1)
                                : const Color.fromRGBO(89, 89, 92, 1),
                            fontSize: 16,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        if (!_isScanning) ...[
                          const SizedBox(height: 8),
                          const Text(
                            'Premi il pulsante per avviare\nla scansione',
                            textAlign: TextAlign.center,
                            style:
                                TextStyle(color: Color.fromRGBO(89, 89, 92, 0.7), fontSize: 14),
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
                      final deviceName = devicesProvider.getDeviceName(device);
                      final deviceType = _identifyDeviceType(deviceName);
                      final deviceEmoji = _getDeviceEmoji(deviceType, device, devicesProvider);
                      final deviceTypeName = _getDeviceTypeName(deviceType);
                      final isAlreadyConnected = devicesProvider.isConnected(device);

                      return Container(
                        margin: const EdgeInsets.only(bottom: 12),
                        child: Material(
                          color: isAlreadyConnected ? const Color(0xFF1F2E1A) : const Color(0xFF1A1A1A),
                          borderRadius: BorderRadius.circular(16),
                          child: InkWell(
                            borderRadius: BorderRadius.circular(16),
                            onTap: () => _navigateToDeviceScreen(device, deviceName, deviceType),
                            child: Container(
                              padding: const EdgeInsets.all(16),
                              decoration: BoxDecoration(
                                borderRadius: BorderRadius.circular(16),
                                border: Border.all(
                                  color: isAlreadyConnected
                                      ? const Color.fromRGBO(151, 201, 62, 0.6)
                                      : const Color.fromRGBO(89, 89, 92, 0.3),
                                  width: isAlreadyConnected ? 2 : 1,
                                ),
                              ),
                              child: Row(
                                children: [
                                  Container(
                                    width: 48,
                                    height: 48,
                                    decoration: BoxDecoration(
                                      color: isAlreadyConnected
                                          ? const Color.fromRGBO(151, 201, 62, 0.25)
                                          : const Color.fromRGBO(151, 201, 62, 0.15),
                                      borderRadius: BorderRadius.circular(12),
                                    ),
                                    child: Center(
                                      child: Text(
                                        deviceEmoji,
                                        style: const TextStyle(fontSize: 28),
                                      ),
                                    ),
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
                                                deviceName,
                                                style: const TextStyle(
                                                  color: Color.fromRGBO(151, 201, 62, 1),
                                                  fontWeight: FontWeight.w600,
                                                  fontSize: 16,
                                                  letterSpacing: 0.3,
                                                ),
                                                maxLines: 1,
                                                overflow: TextOverflow.ellipsis,
                                              ),
                                            ),
                                            if (isAlreadyConnected)
                                              Container(
                                                padding: const EdgeInsets.symmetric(
                                                    horizontal: 8, vertical: 4),
                                                decoration: BoxDecoration(
                                                  color: const Color.fromRGBO(151, 201, 62, 1),
                                                  borderRadius: BorderRadius.circular(8),
                                                ),
                                                child: const Text(
                                                  'CONNESSO',
                                                  style: TextStyle(
                                                    color: Color(0xFF000000),
                                                    fontSize: 10,
                                                    fontWeight: FontWeight.w700,
                                                  ),
                                                ),
                                              ),
                                          ],
                                        ),
                                        const SizedBox(height: 4),
                                        Text(
                                          deviceTypeName,
                                          style: const TextStyle(
                                            color: Color.fromRGBO(151, 201, 62, 0.7),
                                            fontSize: 13,
                                            fontWeight: FontWeight.w500,
                                            letterSpacing: 0.3,
                                          ),
                                        ),
                                        const SizedBox(height: 4),
                                        Text(
                                          device.remoteId.toString(),
                                          style: const TextStyle(
                                            color: Color.fromRGBO(89, 89, 92, 1),
                                            fontSize: 11,
                                            letterSpacing: 0.3,
                                          ),
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
                                        if (isAlreadyConnected) {
                                          try {
                                            await devicesProvider.disconnectDevice(device);
                                          } catch (e) {
                                            _showMessage('Errore disconnessione: $e');
                                          }
                                        } else {
                                          if (!devicesProvider.canConnectMore) {
                                            _showMessage('Massimo 6 sensori raggiunto');
                                            return;
                                          }
                                          try {
                                            await devicesProvider.connectDevice(device);
                                          } catch (e) {
                                            _showMessage('Errore connessione: $e');
                                          }
                                        }
                                      },
                                      child: Container(
                                        width: 44,
                                        height: 44,
                                        decoration: BoxDecoration(
                                          color: isAlreadyConnected
                                              ? const Color.fromARGB(54, 255, 0, 0)
                                              : const Color.fromRGBO(151, 201, 62, 0.15),
                                          borderRadius: BorderRadius.circular(12),
                                          border: Border.all(
                                            color: isAlreadyConnected
                                                ? const Color.fromARGB(255, 255, 0, 0)
                                                : const Color.fromRGBO(151, 201, 62, 0.3),
                                            width: 1,
                                          ),
                                        ),
                                        child: Icon(
                                          isAlreadyConnected
                                              ? Icons.remove_circle_outline
                                              : Icons.link,
                                          color: isAlreadyConnected
                                              ? const Color.fromARGB(255, 255, 0, 0)
                                              : const Color.fromRGBO(151, 201, 62, 1),
                                          size: 22,
                                        ),
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
