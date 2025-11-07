import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:provider/provider.dart';
import 'dart:async';
import '../models/sensoria_device_type.dart';
import '../providers/connected_devices_provider.dart';
import '../streaming_manager.dart';

class DeviceDetailScreen extends StatefulWidget {
  final BluetoothDevice device;
  final String deviceName;
  final SensoriaDeviceType deviceType;

  const DeviceDetailScreen({
    Key? key,
    required this.device,
    required this.deviceName,
    required this.deviceType,
  }) : super(key: key);

  @override
  State<DeviceDetailScreen> createState() => _DeviceDetailScreenState();
}

class _DeviceDetailScreenState extends State<DeviceDetailScreen> {
  bool _isConnected = false;
  bool _isConnecting = false;

  StreamSubscription<BluetoothConnectionState>? _connectionSubscription;
  List<BluetoothService> _services = [];
  BluetoothService? _imuService;
  BluetoothCharacteristic? _imuCharacteristic;

  final Map<String, String> _emojiMap = {
    'leg': '🦿',
    'foot': '🧦',
    'arm': '🦾',
    'default': '❔',
  };

  StreamingManager? _streamingManager;

  @override
  void initState() {
    super.initState();
    _streamingManager = Provider.of<StreamingManager>(context, listen: false);
    
    _connectionSubscription = widget.device.connectionState.listen((state) {
      if (mounted) {
        setState(() {
          _isConnected = state == BluetoothConnectionState.connected;
        });
      }
    });
  }
  
  @override
  void dispose() {
    _connectionSubscription?.cancel();
    _streamingManager?.stopStreaming(widget.device.remoteId.toString());
    super.dispose();
  }

  String _getDeviceEmoji() {
    final devicesProvider = Provider.of<ConnectedDevicesProvider>(context, listen: false);
    final customIconType = devicesProvider.getDeviceIconType(widget.device);
    
    if (customIconType != null && _emojiMap.containsKey(customIconType)) {
      return _emojiMap[customIconType]!;
    }
    
    return '❔';
  }

  String _getDeviceTypeName() {
    switch (widget.deviceType) {
      case SensoriaDeviceType.core:
        return 'Sensoria Core';
      case SensoriaDeviceType.hrm:
        return 'Heart Rate Monitor';
      case SensoriaDeviceType.sock:
        return 'Smart Sock';
      default:
        return 'Dispositivo Sensoria';
    }
  }

  Widget _buildEmojiSelector({
    required String emoji,
    required String label,
    required String? value,
    required String? currentValue,
    required VoidCallback onTap,
  }) {
    final isSelected = value == currentValue;
    
    return GestureDetector(
      onTap: onTap,
      child: Column(
        children: [
          Container(
            width: 70,
            height: 70,
            decoration: BoxDecoration(
              color: isSelected
                  ? const Color.fromRGBO(151, 201, 62, 0.3)
                  : const Color.fromRGBO(151, 201, 62, 0.1),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(
                color: isSelected
                    ? const Color.fromRGBO(151, 201, 62, 1)
                    : const Color.fromRGBO(89, 89, 92, 0.3),
                width: isSelected ? 2 : 1,
              ),
            ),
            child: Stack(
              children: [
                Center(
                  child: Text(
                    emoji,
                    style: const TextStyle(fontSize: 36),
                  ),
                ),
                if (isSelected)
                  Positioned(
                    top: 4,
                    right: 4,
                    child: Container(
                      width: 20,
                      height: 20,
                      decoration: const BoxDecoration(
                        color: Color.fromRGBO(151, 201, 62, 1),
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(
                        Icons.check,
                        size: 14,
                        color: Color(0xFF000000),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 6),
          Text(
            label,
            style: TextStyle(
              color: isSelected
                  ? const Color.fromRGBO(151, 201, 62, 1)
                  : const Color.fromRGBO(89, 89, 92, 1),
              fontSize: 12,
              fontWeight: isSelected ? FontWeight.w600 : FontWeight.w400,
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _connectToDevice() async {
    setState(() => _isConnecting = true);

    try {
      final devicesProvider = Provider.of<ConnectedDevicesProvider>(context, listen: false);
      final deviceName = devicesProvider.getDeviceName(widget.device);
      
      if (!devicesProvider.isConnected(widget.device)) {
        await devicesProvider.connectDevice(widget.device);
      }
      
      await Future.delayed(const Duration(milliseconds: 100));
      
      final connectionState = await widget.device.connectionState.first;
      if (connectionState != BluetoothConnectionState.connected) {
        throw Exception('Dispositivo non connesso');
      }
      
      debugPrint('✅ Connesso a $deviceName');

      _services = await widget.device.discoverServices();
      debugPrint('✅ Trovati ${_services.length} servizi');

      for (var service in _services) {
        for (var characteristic in service.characteristics) {
          if (characteristic.properties.notify || characteristic.properties.indicate) {
            _imuService = service;
            _imuCharacteristic = characteristic;
            debugPrint('✅ Trovata caratteristica IMU: ${characteristic.uuid}');
            break;
          }
        }
        if (_imuCharacteristic != null) break;
      }

      setState(() {});
      _showMessage('Connesso a $deviceName');
    } catch (e) {
      _showMessage('Errore di connessione: $e');
      debugPrint('❌ Errore connessione: $e');
    } finally {
      if (mounted) setState(() => _isConnecting = false);
    }
  }

  Future<void> _disconnectFromDevice() async {
    debugPrint('🔌 DISCONNESSIONE');
    
    try {
      await widget.device.disconnect();
      debugPrint('✅ Disconnesso');
      
      if (mounted) {
        final devicesProvider = Provider.of<ConnectedDevicesProvider>(context, listen: false);
        final deviceName = devicesProvider.getDeviceName(widget.device);
        _showMessage('Disconnesso da $deviceName');
      }
    } catch (e) {
      debugPrint('❌ Errore disconnessione: $e');
    }
  }

  Future<void> _startStreaming() async {
    if (!_isConnected) {
      _showMessage('Connetti prima il dispositivo');
      return;
    }

    try {
      debugPrint('🔍 Discovery servizi...');
      _services = await widget.device.discoverServices();
      debugPrint('✅ Trovati ${_services.length} servizi\n');
      
      _imuService = null;
      _imuCharacteristic = null;
      
      for (var service in _services) {
        debugPrint('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        debugPrint('📦 SERVICE: ${service.uuid}');
        debugPrint('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        
        for (var characteristic in service.characteristics) {
          final props = characteristic.properties;
          debugPrint('  📍 CHAR: ${characteristic.uuid}');
          debugPrint('     ├─ Read: ${props.read}');
          debugPrint('     ├─ Write: ${props.write}');
          debugPrint('     ├─ WriteWithoutResponse: ${props.writeWithoutResponse}');
          debugPrint('     ├─ Notify: ${props.notify}');
          debugPrint('     └─ Indicate: ${props.indicate}\n');
          
          if (service.uuid.toString().toLowerCase() == '180f') {
            debugPrint('  ⚠️  Battery service - IGNORATO\n');
            continue;
          }
          
          if ((props.notify || props.indicate) && _imuCharacteristic == null) {
            if (characteristic.uuid.toString().contains('1cac0002')) {
              _imuService = service;
              _imuCharacteristic = characteristic;
              debugPrint('  ✅ SELEZIONATA COME IMU CHAR\n');
            }
          }
        }
      }
      
      debugPrint('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      
      setState(() {});
    } catch (e) {
      _showMessage('Errore discovery servizi: $e');
      debugPrint('❌ Errore discovery: $e');
      return;
    }

    if (_imuService == null || _imuCharacteristic == null) {
      _showMessage('Caratteristica IMU non trovata');
      debugPrint('❌ Nessuna caratteristica IMU trovata');
      return;
    }

    debugPrint('🚀 Avvio stream con characteristic: ${_imuCharacteristic!.uuid}');

    try {
      final streamingManager = Provider.of<StreamingManager>(context, listen: false);
      final devicesProvider = Provider.of<ConnectedDevicesProvider>(context, listen: false);
      final deviceName = devicesProvider.getDeviceName(widget.device);

      await streamingManager.startStreaming(widget.device, deviceName);
      Future.delayed(const Duration(seconds: 2), () {
  streamingManager.debugStreamingStatus();
  });

      
      _showMessage('Streaming avviato');
    } catch (e) {
      debugPrint('❌ Errore streaming: $e');
      _showMessage('Errore: $e');
    }
  }

  Future<void> _stopStreaming() async {
    debugPrint('🛑 STOP streaming');
    
    final streamingManager = Provider.of<StreamingManager>(context, listen: false);
    await streamingManager.stopStreaming(widget.device.remoteId.toString());
    
    _showMessage('Streaming fermato');
  }

  void _showMessage(String message) {
    if (!mounted) return;
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

  @override
  Widget build(BuildContext context) {
    final devicesProvider = Provider.of<ConnectedDevicesProvider>(context);
    final streamingManager = Provider.of<StreamingManager>(context);
    final displayName = devicesProvider.getDeviceName(widget.device);
    final deviceId = widget.device.remoteId.toString();
    final isStreaming = streamingManager.isStreaming(deviceId);
    
    return Scaffold(
      appBar: AppBar(
        title: Text(displayName),
        centerTitle: true,
      ),
      body: SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            children: [
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  color: const Color(0xFF1A1A1A),
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(
                      color: const Color.fromRGBO(89, 89, 92, 0.3), width: 1),
                ),
                child: Column(
                  children: [
                    Stack(
                      clipBehavior: Clip.none,
                      children: [
                        Container(
                          width: 80,
                          height: 80,
                          decoration: BoxDecoration(
                            color: const Color.fromRGBO(151, 201, 62, 0.15),
                            borderRadius: BorderRadius.circular(20),
                          ),
                          child: Center(
                            child: Text(
                              _getDeviceEmoji(),
                              style: const TextStyle(fontSize: 48),
                            ),
                          ),
                        ),
                        Positioned(
                          top: -4,
                          right: -4,
                          child: Material(
                            color: Colors.transparent,
                            child: InkWell(
                              borderRadius: BorderRadius.circular(20),
                              onTap: () async {
                                final currentIconType = devicesProvider.getDeviceIconType(widget.device);
                                final currentName = devicesProvider.getDeviceName(widget.device);
                                final TextEditingController nameController = TextEditingController(text: currentName);
                                
                                String? selectedIcon = currentIconType;
                                
                                final result = await showDialog<Map<String, dynamic>>(
                                  context: context,
                                  builder: (context) => StatefulBuilder(
                                    builder: (context, setDialogState) => AlertDialog(
                                      backgroundColor: const Color(0xFF1A1A1A),
                                      title: const Text(
                                        'Personalizza dispositivo',
                                        style: TextStyle(color: Color.fromRGBO(151, 201, 62, 1), fontSize: 18),
                                      ),
                                      content: SingleChildScrollView(
                                        child: Column(
                                          mainAxisSize: MainAxisSize.min,
                                          crossAxisAlignment: CrossAxisAlignment.start,
                                          children: [
                                            const Text(
                                              'Nome personalizzato',
                                              style: TextStyle(
                                                color: Color.fromRGBO(151, 201, 62, 1),
                                                fontSize: 14,
                                                fontWeight: FontWeight.w600,
                                              ),
                                            ),
                                            const SizedBox(height: 8),
                                            TextField(
                                              controller: nameController,
                                              style: const TextStyle(color: Colors.white),
                                              decoration: InputDecoration(
                                                hintText: 'Es: Ginocchio DX',
                                                hintStyle: const TextStyle(color: Color.fromRGBO(89, 89, 92, 1)),
                                                filled: true,
                                                fillColor: const Color(0xFF0F0F0F),
                                                border: OutlineInputBorder(
                                                  borderRadius: BorderRadius.circular(8),
                                                  borderSide: BorderSide.none,
                                                ),
                                              ),
                                            ),
                                            const SizedBox(height: 20),
                                            const Text(
                                              'Scegli icona',
                                              style: TextStyle(
                                                color: Color.fromRGBO(151, 201, 62, 1),
                                                fontSize: 14,
                                                fontWeight: FontWeight.w600,
                                              ),
                                            ),
                                            const SizedBox(height: 12),
                                            Row(
                                              mainAxisAlignment: MainAxisAlignment.spaceAround,
                                              children: [
                                                _buildEmojiSelector(
                                                  emoji: '🦿',
                                                  label: 'Gamba',
                                                  value: 'leg',
                                                  currentValue: selectedIcon,
                                                  onTap: () {
                                                    setDialogState(() => selectedIcon = 'leg');
                                                  },
                                                ),
                                                _buildEmojiSelector(
                                                  emoji: '🧦',
                                                  label: 'Piede',
                                                  value: 'foot',
                                                  currentValue: selectedIcon,
                                                  onTap: () {
                                                    setDialogState(() => selectedIcon = 'foot');
                                                  },
                                                ),
                                                _buildEmojiSelector(
                                                  emoji: '🦾',
                                                  label: 'Braccio',
                                                  value: 'arm',
                                                  currentValue: selectedIcon,
                                                  onTap: () {
                                                    setDialogState(() => selectedIcon = 'arm');
                                                  },
                                                ),
                                              ],
                                            ),
                                          ],
                                        ),
                                      ),
                                      actions: [
                                        TextButton(
                                          onPressed: () => Navigator.of(context).pop(),
                                          child: const Text('Annulla'),
                                        ),
                                        ElevatedButton(
                                          onPressed: () {
                                            Navigator.of(context).pop({
                                              'name': nameController.text.trim(),
                                              'icon': selectedIcon,
                                            });
                                          },
                                          child: const Text('Salva'),
                                        ),
                                      ],
                                    ),
                                  ),
                                );
                                
                                if (result != null) {
                                  final newName = result['name'] as String;
                                  final newIcon = result['icon'] as String?;
                                  
                                  if (newName.isNotEmpty) {
                                    devicesProvider.updateDeviceName(widget.device, newName);
                                  }
                                  if (newIcon != null) {
                                    devicesProvider.updateDeviceIcon(widget.device, newIcon);
                                  }
                                  
                                  setState(() {});
                                  _showMessage('Dispositivo aggiornato');
                                }
                              },
                              child: Container(
                                width: 32,
                                height: 32,
                                decoration: const BoxDecoration(
                                  color: Color.fromRGBO(151, 201, 62, 1),
                                  shape: BoxShape.circle,
                                ),
                                child: const Icon(
                                  Icons.edit,
                                  size: 18,
                                  color: Color(0xFF000000),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 16),
                    Text(
                      displayName,
                      style: const TextStyle(
                        color: Color.fromRGBO(151, 201, 62, 1),
                        fontSize: 22,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      _getDeviceTypeName(),
                      style: const TextStyle(
                        color: Color.fromRGBO(151, 201, 62, 0.7),
                        fontSize: 14,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      widget.device.remoteId.toString(),
                      style: const TextStyle(
                        color: Color.fromRGBO(89, 89, 92, 1),
                        fontSize: 12,
                      ),
                    ),
                    const SizedBox(height: 20),
                    
                    Container(
                      padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 16),
                      decoration: BoxDecoration(
                        color: _isConnected
                            ? const Color.fromRGBO(151, 201, 62, 0.15)
                            : const Color.fromRGBO(255, 68, 68, 0.15),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(
                          color: _isConnected
                              ? const Color.fromRGBO(151, 201, 62, 0.5)
                              : const Color.fromRGBO(255, 68, 68, 0.5),
                          width: 1,
                        ),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            _isConnected ? Icons.check_circle : Icons.cancel,
                            color: _isConnected
                                ? const Color.fromRGBO(151, 201, 62, 1)
                                : const Color(0xFFFF4444),
                            size: 20,
                          ),
                          const SizedBox(width: 8),
                          Text(
                            _isConnected ? 'CONNESSO' : 'DISCONNESSO',
                            style: TextStyle(
                              color: _isConnected
                                  ? const Color.fromRGBO(151, 201, 62, 1)
                                  : const Color(0xFFFF4444),
                              fontWeight: FontWeight.w700,
                              fontSize: 14,
                            ),
                          ),
                        ],
                      ),
                    ),
                    
                    if (isStreaming) ...[
                      const SizedBox(height: 12),
                      Container(
                        padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 12),
                        decoration: BoxDecoration(
                          color: const Color.fromRGBO(151, 201, 62, 0.2),
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Container(
                              width: 8,
                              height: 8,
                              decoration: const BoxDecoration(
                                color: Color.fromRGBO(151, 201, 62, 1),
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 8),
                            const Text(
                              'STREAMING ATTIVO',
                              style: TextStyle(
                                color: Color.fromRGBO(151, 201, 62, 1),
                                fontSize: 12,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              
              const SizedBox(height: 16),
              
              if (_isConnecting)
                const CircularProgressIndicator(
                  color: Color.fromRGBO(151, 201, 62, 1),
                )
              else if (!_isConnected)
                SizedBox(
                  width: double.infinity,
                  height: 56,
                  child: ElevatedButton.icon(
                    onPressed: _connectToDevice,
                    icon: const Icon(Icons.bluetooth_connected),
                    label: const Text('CONNETTI'),
                  ),
                )
              else
                Column(
                  children: [
                    const SizedBox(height: 12),
                    SizedBox(
                      width: double.infinity,
                      height: 48,
                      child: OutlinedButton.icon(
                        onPressed: _disconnectFromDevice,
                        icon: const Icon(Icons.power_settings_new, color: Color(0xFFFF4444),),
                        label: const Text('DISCONNETTI',
                          style: TextStyle(
                            color: Color(0xFFFF4444)
                          )

                        ),
                        style: OutlinedButton.styleFrom(
                          side: const BorderSide(
                            color: Color(0xFFFF4444),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }
}
