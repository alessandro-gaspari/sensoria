import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:google_fonts/google_fonts.dart';
import '../providers/profile_provider.dart';

// --- SCHERMATA GESTIONE LISTA PROFILI ---
class ProfilesListScreen extends StatelessWidget {
  const ProfilesListScreen({Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context) {
    final provider = Provider.of<ProfileProvider>(context);

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: Image.asset('assets/logo_Clean.png', height: 28),
        centerTitle: true,
        backgroundColor: Colors.black,
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.add, color: Color.fromRGBO(151, 201, 62, 1)),
            onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const ProfileFormScreen())),
          )
        ],
      ),
      body: ListView.builder(
        padding: const EdgeInsets.all(16),
        itemCount: provider.profiles.length,
        itemBuilder: (context, index) {
          final profile = provider.profiles[index];
          final isActive = profile.id == provider.activeProfile?.id;
          final isMale = profile.gender == "M";

          return Container(
            margin: const EdgeInsets.only(bottom: 12),
            decoration: BoxDecoration(
              color: const Color(0xFF1A1A1A),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(
                color: isActive ? const Color.fromRGBO(151, 201, 62, 1) : Colors.white10, 
                width: isActive ? 2 : 1
              ),
            ),
            child: ListTile(
              onTap: () => provider.setActiveProfile(profile.id),
              contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              
              // 1. AVATAR A SINISTRA (Al posto del simbolo sesso)
              leading: Container(
                width: 60, height: 60,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: isActive ? const Color.fromRGBO(151, 201, 62, 0.2) : Colors.white10,
                  border: Border.all(
                    color: isActive ? const Color.fromRGBO(151, 201, 62, 1) : Colors.white24,
                    width: 2
                  )
                ),
                child: Center(
                  child: Text(
                    profile.avatar, 
                    style: const TextStyle(fontSize: 32)
                  ),
                ),
              ),
              
              title: Text(
                profile.name,
                style: GoogleFonts.barlowCondensed(color: Colors.white, fontSize: 24, fontWeight: FontWeight.bold),
              ),
              
              // 2. SESSO SPOSTATO NEL SOTTOTITOLO (A fianco del peso)
              // ... dentro ListTile ...
              
              subtitle: Padding(
                padding: const EdgeInsets.only(top: 8.0),
                // CORREZIONE: Scroll orizzontale per non andare a capo
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: Row(
                    children: [
                      _buildInfoBadge("${profile.age} anni"),
                      const SizedBox(width: 8),
                      _buildInfoBadge("${profile.weight} kg"),
                      const SizedBox(width: 8),
                      // Badge Sesso
  Container(
                      width: 24, height: 24, // Dimensione fissa quadrata
                      decoration: BoxDecoration(
                        color: isMale ? Colors.blue.withOpacity(0.2) : Colors.pink.withOpacity(0.2),
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(
                          color: isMale ? Colors.blue : Colors.pink,
                          width: 1
                        )
                      ),
                      child: Center(
                        child: Icon(
                          isMale ? Icons.male : Icons.female, 
                          size: 16, 
                          color: isMale ? Colors.blue : Colors.pink
                        ),
                      ),
                    ),
                    ],
                  ),
                ),
              ),
              
              // ... resto del codice ...

              
              trailing: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  IconButton(
                    icon: const Icon(Icons.edit, color: Colors.white70),
                    onPressed: () => Navigator.push(
                      context, 
                      MaterialPageRoute(builder: (_) => ProfileFormScreen(profileToEdit: profile))
                    ),
                  ),
                  if (provider.profiles.length > 1)
                    IconButton(
                      icon: const Icon(Icons.delete, color: Colors.red),
                      onPressed: () => provider.deleteProfile(profile.id),
                    ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }

  Widget _buildInfoBadge(String text) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: Colors.white10,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        text,
        style: GoogleFonts.barlow(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.w500),
      ),
    );
  }
}

// --- SCHERMATA FORM (CREAZIONE/MODIFICA) ---
class ProfileFormScreen extends StatefulWidget {
  final UserProfile? profileToEdit;
  const ProfileFormScreen({Key? key, this.profileToEdit}) : super(key: key);

  @override
  State<ProfileFormScreen> createState() => _ProfileFormScreenState();
}

class _ProfileFormScreenState extends State<ProfileFormScreen> {
  final _formKey = GlobalKey<FormState>();
  late TextEditingController _nameCtrl;
  late TextEditingController _ageCtrl;
  late TextEditingController _weightCtrl;
  String _gender = "M";
  String _selectedAvatar = "👤"; 

  // LISTA AVATAR
  final List<String> _avatars = [
    "👤", "🏃‍♂️", "🏃‍♀️", "🏋️‍♂️", "🏋️‍♀️", 
    "🚴‍♂️", "🚴‍♀️", "🧘", "🤸", "🥷", "🦸‍♂️", "🦸‍♀️", 
    "🤖", "👽", "🦊", "🐯"
  ];

  @override
  void initState() {
    super.initState();
    _nameCtrl = TextEditingController(text: widget.profileToEdit?.name ?? "");
    _ageCtrl = TextEditingController(text: widget.profileToEdit?.age.toString() ?? "");
    _weightCtrl = TextEditingController(text: widget.profileToEdit?.weight.toString() ?? "");
    if (widget.profileToEdit != null) {
      _gender = widget.profileToEdit!.gender;
      _selectedAvatar = widget.profileToEdit!.avatar;
    }
  }

  void _save() async {
    if (_formKey.currentState!.validate()) {
      final provider = Provider.of<ProfileProvider>(context, listen: false);
      final name = _nameCtrl.text;
      final age = int.parse(_ageCtrl.text);
      final weight = double.parse(_weightCtrl.text);

      if (widget.profileToEdit == null) {
        // Passiamo l'avatar selezionato
        await provider.addProfile(name, age, _gender, weight, _selectedAvatar);
      } else {
        await provider.updateProfile(widget.profileToEdit!.id, name, age, _gender, weight, _selectedAvatar);
      }

      if (mounted) {
        if (Navigator.canPop(context)) {
          Navigator.pop(context);
        }
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final isEditing = widget.profileToEdit != null;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: Text(
          isEditing ? "MODIFICA PROFILO" : "CREA PROFILO", 
          style: GoogleFonts.barlowCondensed(fontWeight: FontWeight.bold, letterSpacing: 1.0)
        ),
        backgroundColor: Colors.black,
        centerTitle: true,
        leading: isEditing ? const BackButton() : null,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // 1. INPUT DATI
              _buildInput("NOME", _nameCtrl, false),
              const SizedBox(height: 16),
              Row(children: [
                Expanded(child: _buildInput("ETÀ", _ageCtrl, true)),
                const SizedBox(width: 16),
                Expanded(child: _buildInput("PESO (KG)", _weightCtrl, true)),
              ]),
              
              const SizedBox(height: 30),
              
              // 2. SELEZIONE SESSO (CARDS)
              Text("SESSO", style: GoogleFonts.barlowCondensed(color: Colors.white, fontSize: 16, fontWeight: FontWeight.bold)),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(child: _buildGenderCard("M")),
                  const SizedBox(width: 16),
                  Expanded(child: _buildGenderCard("F")),
                ],
              ),

              const SizedBox(height: 30),

              // 3. SELEZIONE AVATAR (GRIGLIA ORIZZONTALE)
              Text("SCEGLI AVATAR", style: GoogleFonts.barlowCondensed(color: Colors.white, fontSize: 16, fontWeight: FontWeight.bold)),
              const SizedBox(height: 12),
              SizedBox(
                height: 80,
                child: ListView.builder(
                  scrollDirection: Axis.horizontal,
                  itemCount: _avatars.length,
                  itemBuilder: (context, index) {
                    final avatar = _avatars[index];
                    final isSelected = _selectedAvatar == avatar;
                    return GestureDetector(
                      onTap: () => setState(() => _selectedAvatar = avatar),
                      child: AnimatedContainer(
                        duration: const Duration(milliseconds: 200),
                        width: 70,
                        margin: const EdgeInsets.only(right: 12),
                        decoration: BoxDecoration(
                          color: isSelected ? const Color.fromRGBO(151, 201, 62, 0.2) : const Color(0xFF1A1A1A),
                          borderRadius: BorderRadius.circular(16),
                          border: Border.all(
                            color: isSelected ? const Color.fromRGBO(151, 201, 62, 1) : Colors.white10,
                            width: isSelected ? 2 : 1
                          )
                        ),
                        child: Center(
                          child: Text(avatar, style: const TextStyle(fontSize: 32)),
                        ),
                      ),
                    );
                  },
                ),
              ),

              const SizedBox(height: 40),
              
              // 4. SAVE BUTTON
              SizedBox(
                width: double.infinity,
                height: 56,
                child: ElevatedButton(
                  onPressed: _save,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color.fromRGBO(151, 201, 62, 1),
                    foregroundColor: Colors.black,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                  ),
                  child: Text("SALVA PROFILO", style: GoogleFonts.barlowCondensed(fontSize: 20, fontWeight: FontWeight.bold, letterSpacing: 1.0)),
                ),
              )
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildInput(String label, TextEditingController ctrl, bool isNumber) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: GoogleFonts.barlowCondensed(color: Colors.white70, fontSize: 12, fontWeight: FontWeight.bold)),
        const SizedBox(height: 8),
        TextFormField(
          controller: ctrl,
          keyboardType: isNumber ? TextInputType.number : TextInputType.text,
          style: GoogleFonts.barlow(color: Colors.white, fontSize: 18, fontWeight: FontWeight.w600),
          cursorColor: const Color.fromRGBO(151, 201, 62, 1),
          validator: (v) => v!.isEmpty ? "Richiesto" : null,
          decoration: InputDecoration(
            filled: true,
            fillColor: const Color(0xFF1A1A1A),
            contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
            focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Color.fromRGBO(151, 201, 62, 1))),
          ),
        ),
      ],
    );
  }

  Widget _buildGenderCard(String genderType) {
    final isMale = genderType == "M";
    final isSelected = _gender == genderType;
    
    final activeColor = isMale ? Colors.blueAccent : Colors.pinkAccent;
    final bgColor = isSelected ? activeColor.withOpacity(0.2) : const Color(0xFF1A1A1A);
    final borderColor = isSelected ? activeColor : Colors.white10;

    return GestureDetector(
      onTap: () => setState(() => _gender = genderType),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        height: 120, // Quasi quadrato
        decoration: BoxDecoration(
          color: bgColor,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: borderColor, width: isSelected ? 2 : 1),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              isMale ? Icons.male : Icons.female,
              size: 50,
              color: isSelected ? activeColor : Colors.white24,
            ),
            const SizedBox(height: 8),
            Text(
              isMale ? "MASCHIO" : "FEMMINA",
              style: GoogleFonts.barlowCondensed(
                color: isSelected ? activeColor : Colors.white24,
                fontWeight: FontWeight.bold,
                fontSize: 16
              ),
            )
          ],
        ),
      ),
    );
  }
}
