import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'screens/scanner_screen.dart';
import 'providers/connected_devices_provider.dart';
import 'streaming_manager.dart';

void main() {
  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => ConnectedDevicesProvider()),
        ChangeNotifierProvider(create: (_) => StreamingManager()),
      ],
      child: const SensoriaBleScannerApp(),
    ),
  );
}

class SensoriaBleScannerApp extends StatelessWidget {
  const SensoriaBleScannerApp({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Sensoria',
      debugShowCheckedModeBanner: false,
      themeMode: ThemeMode.dark,
      darkTheme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        colorScheme: ColorScheme.dark(
          primary: const Color.fromRGBO(151, 201, 62, 1),
          secondary: const Color.fromRGBO(151, 201, 62, 0.8),
          tertiary: const Color.fromRGBO(151, 201, 62, 0.6),
          surface: const Color(0xFF0F0F0F),
          surfaceContainerHighest: const Color.fromRGBO(89, 89, 92, 0.3),
          surfaceContainer: const Color(0xFF121212),
          onPrimary: const Color(0xFF000000),
          onSecondary: const Color(0xFF000000),
          onSurface: const Color(0xFFE8E8E8),
          onSurfaceVariant: const Color.fromRGBO(89, 89, 92, 1),
          outline: const Color.fromRGBO(89, 89, 92, 0.5),
          error: const Color(0xFFFF4444),
        ),
        scaffoldBackgroundColor: const Color(0xFF0A0A0A),
        appBarTheme: const AppBarTheme(
          backgroundColor: Color(0xFF0F0F0F),
          foregroundColor: Color.fromRGBO(151, 201, 62, 1),
          elevation: 0,
          centerTitle: true,
        ),
        cardTheme: const CardThemeData(
          color: Color(0xFF1A1A1A),
          elevation: 0,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.all(Radius.circular(16)),
            side: BorderSide(
              color: Color.fromRGBO(89, 89, 92, 0.3),
              width: 1,
            ),
          ),
        ),
        elevatedButtonTheme: ElevatedButtonThemeData(
          style: ElevatedButton.styleFrom(
            backgroundColor: const Color.fromRGBO(151, 201, 62, 1),
            foregroundColor: const Color(0xFF000000),
            elevation: 0,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
            ),
            textStyle: const TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.8,
            ),
          ),
        ),
        textTheme: const TextTheme(
          displayLarge: TextStyle(
            fontSize: 32,
            fontWeight: FontWeight.w700,
            color: Color.fromRGBO(151, 201, 62, 1),
            letterSpacing: -0.5,
          ),
          titleLarge: TextStyle(
            fontSize: 20,
            fontWeight: FontWeight.w600,
            color: Color.fromRGBO(151, 201, 62, 1),
            letterSpacing: 0.15,
          ),
          titleMedium: TextStyle(
            fontSize: 16,
            fontWeight: FontWeight.w600,
            color: Color(0xFFE8E8E8),
            letterSpacing: 0.15,
          ),
          bodyLarge: TextStyle(
            fontSize: 16,
            fontWeight: FontWeight.w400,
            color: Color(0xFFE8E8E8),
            letterSpacing: 0.5,
          ),
          bodyMedium: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w400,
            color: Color.fromRGBO(89, 89, 92, 1),
            letterSpacing: 0.25,
          ),
          labelSmall: TextStyle(
            fontSize: 12,
            fontWeight: FontWeight.w500,
            color: Color.fromRGBO(89, 89, 92, 1),
            letterSpacing: 0.5,
          ),
        ),
        iconTheme: const IconThemeData(
          color: Color.fromRGBO(151, 201, 62, 1),
          size: 24,
        ),
      ),
      home: const ScannerScreen(),
    );
  }
}
