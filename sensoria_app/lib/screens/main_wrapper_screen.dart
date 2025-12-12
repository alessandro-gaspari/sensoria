import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'scanner_screen.dart';
import 'profile_screen.dart';

class MainWrapperScreen extends StatefulWidget {
  const MainWrapperScreen({Key? key}) : super(key: key);

  @override
  State<MainWrapperScreen> createState() => _MainWrapperScreenState();
}

class _MainWrapperScreenState extends State<MainWrapperScreen> {
  int _currentIndex = 0;
  
  // Le due pagine principali dell'app
  final List<Widget> _pages = [
    const ScannerScreen(),      // Index 0: Home / Scanner
    const ProfilesListScreen(), // Index 1: Gestione Profili
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      
      // IndexedStack mantiene lo stato delle pagine (non le ricarica ogni volta che cambi tab)
      body: IndexedStack(
        index: _currentIndex,
        children: _pages,
      ),
      
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(
          border: Border(top: BorderSide(color: Colors.white10, width: 1)),
        ),
        // Theme wrapper per rimuovere gli effetti "alone" (Splash/Highlight) al click
        child: Theme(
          data: Theme.of(context).copyWith(
            splashColor: Colors.transparent,
            highlightColor: Colors.transparent,
            hoverColor: Colors.transparent,
          ),
          child: BottomNavigationBar(
            backgroundColor: Colors.black,
            currentIndex: _currentIndex,
            type: BottomNavigationBarType.fixed,
            elevation: 0,
            
            // Colori Attivo/Inattivo
            selectedItemColor: const Color.fromRGBO(151, 201, 62, 1),
            unselectedItemColor: Colors.white38,
            
            // Font personalizzato
            selectedLabelStyle: GoogleFonts.barlowCondensed(
              fontWeight: FontWeight.bold, 
              fontSize: 12,
              letterSpacing: 0.5
            ),
            unselectedLabelStyle: GoogleFonts.barlowCondensed(
              fontWeight: FontWeight.w500, 
              fontSize: 12,
              letterSpacing: 0.5
            ),
            
            onTap: (index) => setState(() => _currentIndex = index),
            
            items: const [
              BottomNavigationBarItem(
                icon: Padding(
                  padding: EdgeInsets.only(bottom: 4),
                  child: Icon(Icons.home_filled),
                ),
                label: 'HOME',
              ),
              BottomNavigationBarItem(
                icon: Padding(
                  padding: EdgeInsets.only(bottom: 4),
                  child: Icon(Icons.person),
                ),
                label: 'PROFILI',
              ),
            ],
          ),
        ),
      ),
    );
  }
}
