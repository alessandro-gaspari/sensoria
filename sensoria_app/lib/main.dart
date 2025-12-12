import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:provider/provider.dart';

// Providers
import 'providers/connected_devices_provider.dart';
import 'streaming_manager.dart';
import 'providers/profile_provider.dart'; // <--- NUOVO PROVIDER

// Screens
import 'screens/profile_screen.dart'; // <--- Per il wizard iniziale
import 'screens/main_wrapper_screen.dart'; // <--- Per la navigazione a Tab

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  
  // Disabilita BLE in release mode se necessario
  FlutterBluePlus.setLogLevel(LogLevel.info);
  
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return MultiProvider(
      providers: [
        ChangeNotifierProvider(
          create: (context) => ConnectedDevicesProvider(),
          lazy: false,
        ),
        ChangeNotifierProvider(
          create: (context) => StreamingManager(),
          lazy: false,
        ),
        // --- NUOVO PROVIDER PROFILI ---
        ChangeNotifierProvider(
          create: (context) => ProfileProvider(),
          lazy: false, // Carica subito i dati da disco
        ),
      ],
      child: MaterialApp(
        debugShowCheckedModeBanner: false,
        title: 'Sensoria',
        theme: ThemeData(
          useMaterial3: true,
          brightness: Brightness.dark,
          primaryColor: const Color.fromRGBO(151, 201, 62, 1),
          scaffoldBackgroundColor: const Color(0xFF0F0F0F),
          
          // AppBar Theme
          appBarTheme: const AppBarTheme(
            backgroundColor: Color(0xFF1A1A1A),
            elevation: 0,
            centerTitle: true,
            titleTextStyle: TextStyle(
              color: Color.fromRGBO(151, 201, 62, 1),
              fontSize: 20,
              fontWeight: FontWeight.w700,
              letterSpacing: 0.5,
            ),
            iconTheme: IconThemeData(
              color: Color.fromRGBO(151, 201, 62, 1),
            ),
          ),
          
          // Elevated Button Theme
          elevatedButtonTheme: ElevatedButtonThemeData(
            style: ElevatedButton.styleFrom(
              backgroundColor: const Color.fromRGBO(151, 201, 62, 1),
              foregroundColor: const Color(0xFF000000),
              disabledBackgroundColor: const Color.fromRGBO(89, 89, 92, 0.3),
              disabledForegroundColor: const Color.fromRGBO(89, 89, 92, 1),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              elevation: 0,
              textStyle: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.5,
              ),
              padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 20),
            ),
          ),
          
          // Outlined Button Theme
          outlinedButtonTheme: OutlinedButtonThemeData(
            style: OutlinedButton.styleFrom(
              foregroundColor: const Color.fromRGBO(151, 201, 62, 1),
              side: const BorderSide(
                color: Color.fromRGBO(151, 201, 62, 1),
                width: 2,
              ),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12),
              ),
              elevation: 0,
              textStyle: const TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.5,
              ),
              padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 20),
            ),
          ),
          
          // Text Button Theme
          textButtonTheme: TextButtonThemeData(
            style: TextButton.styleFrom(
              foregroundColor: const Color.fromRGBO(151, 201, 62, 1),
              textStyle: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          
          // Input Decoration Theme
          inputDecorationTheme: InputDecorationTheme(
            filled: true,
            fillColor: const Color(0xFF1A1A1A),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(
                color: Color.fromRGBO(89, 89, 92, 0.3),
              ),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(
                color: Color.fromRGBO(89, 89, 92, 0.3),
              ),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(
                color: Color.fromRGBO(151, 201, 62, 1),
                width: 2,
              ),
            ),
            hintStyle: const TextStyle(
              color: Color.fromRGBO(89, 89, 92, 0.7),
              fontSize: 14,
            ),
            labelStyle: const TextStyle(
              color: Color.fromRGBO(151, 201, 62, 1),
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ),
          ),
          
          // Dialog Theme
          dialogTheme: DialogThemeData(
            backgroundColor: const Color(0xFF1A1A1A),
            elevation: 0,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(16),
              side: const BorderSide(
                color: Color.fromRGBO(89, 89, 92, 0.3),
              ),
            ),
            titleTextStyle: const TextStyle(
              color: Color.fromRGBO(151, 201, 62, 1),
              fontSize: 18,
              fontWeight: FontWeight.w700,
            ),
            contentTextStyle: const TextStyle(
              color: Colors.white,
              fontSize: 14,
            ),
          ),
          
          // Snackbar Theme
          snackBarTheme: const SnackBarThemeData(
            backgroundColor: Color.fromRGBO(151, 201, 62, 1),
            contentTextStyle: TextStyle(
              color: Color(0xFF000000),
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.all(Radius.circular(12)),
            ),
            behavior: SnackBarBehavior.floating,
          ),
          
          // Scrollbar Theme
          scrollbarTheme: ScrollbarThemeData(
            thumbColor: MaterialStateProperty.all(
              const Color.fromRGBO(151, 201, 62, 0.5),
            ),
            trackColor: MaterialStateProperty.all(
              const Color.fromRGBO(89, 89, 92, 0.1),
            ),
          ),
          
          // Progress Indicator Theme
          progressIndicatorTheme: const ProgressIndicatorThemeData(
            color: Color.fromRGBO(151, 201, 62, 1),
            linearMinHeight: 4,
          ),
        ),
        // Sostituiamo ScannerScreen diretto con il wrapper di controllo
        home: const AuthCheckWrapper(), 
      ),
    );
  }
}

// === WIDGET DI CONTROLLO INIZIALE ===
class AuthCheckWrapper extends StatelessWidget {
  const AuthCheckWrapper({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    // Ascolta il provider dei profili
    final profileProvider = Provider.of<ProfileProvider>(context);

    // 1. Se sta ancora caricando da disco, mostra spinner
    if (profileProvider.isLoading) {
      return const Scaffold(
        backgroundColor: Colors.black,
        body: Center(
          child: CircularProgressIndicator(color: Color.fromRGBO(151, 201, 62, 1)),
        ),
      );
    }

    // 2. Se non ci sono profili nel DB, mostra la schermata di creazione (Wizard)
    if (profileProvider.profiles.isEmpty) {
      return const ProfileFormScreen(); // Schermata obbligatoria
    }

    // 3. Se ci sono profili, mostra l'app principale con la BottomBar (Wrapper)
    return const MainWrapperScreen();
  }
}
