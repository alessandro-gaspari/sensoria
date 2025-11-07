/// ⭐ Classe per il filtraggio EMA dei dati IMU (versione semplificata come Swift)
class SensorFilter {
  static const double DEFAULT_ALPHA = 0.1; // Fattore di smoothing (0-1)
  
  // Ultimi valori filtrati per ogni asse
  double _lastAccelX = 0.0;
  double _lastAccelY = 0.0;
  double _lastAccelZ = 0.0;
  
  double _lastGyroX = 0.0;
  double _lastGyroY = 0.0;
  double _lastGyroZ = 0.0;
  
  double _lastMagX = 0.0;
  double _lastMagY = 0.0;
  double _lastMagZ = 0.0;
  
  final double alpha;
  bool _initialized = false;
  
  SensorFilter({this.alpha = DEFAULT_ALPHA});
  
  /// ⭐ Filtra un singolo valore con EMA
  double _filterValue(double newValue, double lastValue) {
    if (!_initialized) {
      return newValue;
    }
    // Formula EMA: filtered = last + alpha * (new - last)
    return lastValue + alpha * (newValue - lastValue);
  }
  
  /// ⭐ Filtra i dati IMU con EMA (come in Swift)
  Map<String, double> filterIMUData({
    required int rawAccelX,
    required int rawAccelY,
    required int rawAccelZ,
    required int rawGyroX,
    required int rawGyroY,
    required int rawGyroZ,
    required int rawMagX,
    required int rawMagY,
    required int rawMagZ,
  }) {
    // ⭐ Converti raw a valori fisici (fattori di scala Sensoria)
    final double accelX = rawAccelX / 4096.0;
    final double accelY = rawAccelY / 4096.0;
    final double accelZ = rawAccelZ / 4096.0;
    
    final double gyroX = rawGyroX / 65.54;
    final double gyroY = rawGyroY / 65.54;
    final double gyroZ = rawGyroZ / 65.54;
    
    final double magX = rawMagX * 0.3;
    final double magY = rawMagY * 0.3;
    final double magZ = rawMagZ * 0.3;
    
    // ⭐ Se prima volta, inizializza senza filtro
    if (!_initialized) {
      _lastAccelX = accelX;
      _lastAccelY = accelY;
      _lastAccelZ = accelZ;
      
      _lastGyroX = gyroX;
      _lastGyroY = gyroY;
      _lastGyroZ = gyroZ;
      
      _lastMagX = magX;
      _lastMagY = magY;
      _lastMagZ = magZ;
      
      _initialized = true;
      
      return {
        'accel_x': _lastAccelX,
        'accel_y': _lastAccelY,
        'accel_z': _lastAccelZ,
        'gyro_x': _lastGyroX,
        'gyro_y': _lastGyroY,
        'gyro_z': _lastGyroZ,
        'mag_x': _lastMagX,
        'mag_y': _lastMagY,
        'mag_z': _lastMagZ,
      };
    }
    
    // ⭐ EMA Formula (come Swift): filtered = last + alpha * (new - last)
    _lastAccelX = _filterValue(accelX, _lastAccelX);
    _lastAccelY = _filterValue(accelY, _lastAccelY);
    _lastAccelZ = _filterValue(accelZ, _lastAccelZ);
    
    _lastGyroX = _filterValue(gyroX, _lastGyroX);
    _lastGyroY = _filterValue(gyroY, _lastGyroY);
    _lastGyroZ = _filterValue(gyroZ, _lastGyroZ);
    
    _lastMagX = _filterValue(magX, _lastMagX);
    _lastMagY = _filterValue(magY, _lastMagY);
    _lastMagZ = _filterValue(magZ, _lastMagZ);
    
    return {
      'accel_x': _lastAccelX,
      'accel_y': _lastAccelY,
      'accel_z': _lastAccelZ,
      'gyro_x': _lastGyroX,
      'gyro_y': _lastGyroY,
      'gyro_z': _lastGyroZ,
      'mag_x': _lastMagX,
      'mag_y': _lastMagY,
      'mag_z': _lastMagZ,
    };
  }
  
  /// ⭐ Reset del filtro
  void reset() {
    _initialized = false;
    _lastAccelX = 0.0;
    _lastAccelY = 0.0;
    _lastAccelZ = 0.0;
    _lastGyroX = 0.0;
    _lastGyroY = 0.0;
    _lastGyroZ = 0.0;
    _lastMagX = 0.0;
    _lastMagY = 0.0;
    _lastMagZ = 0.0;
  }
}
