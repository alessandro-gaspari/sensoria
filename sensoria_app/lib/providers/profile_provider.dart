import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

class UserProfile {
  final String id;
  String name;
  int age;
  String gender; // "M" o "F"
  double weight;
  String avatar; // <--- NUOVO CAMPO

  UserProfile({
    required this.id,
    required this.name,
    required this.age,
    required this.gender,
    required this.weight,
    required this.avatar,
  });

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'age': age,
    'gender': gender,
    'weight': weight,
    'avatar': avatar, // <--- SALVIAMO L'AVATAR
  };

  factory UserProfile.fromJson(Map<String, dynamic> json) {
    return UserProfile(
      id: json['id'],
      name: json['name'],
      age: json['age'],
      gender: json['gender'],
      weight: json['weight'].toDouble(),
      avatar: json['avatar'] ?? "👤", // <--- DEFAULT PER VECCHI PROFILI
    );
  }
}

class ProfileProvider with ChangeNotifier {
  List<UserProfile> _profiles = [];
  String? _activeProfileId;
  bool _isLoading = true;

  List<UserProfile> get profiles => _profiles;
  bool get isLoading => _isLoading;
  
  UserProfile? get activeProfile {
    if (_activeProfileId == null) return null;
    try {
      return _profiles.firstWhere((p) => p.id == _activeProfileId);
    } catch (_) {
      return _profiles.isNotEmpty ? _profiles.first : null;
    }
  }

  ProfileProvider() {
    _loadData();
  }

  Future<void> _loadData() async {
    final prefs = await SharedPreferences.getInstance();
    final String? profilesJson = prefs.getString('profiles_db');
    final String? activeId = prefs.getString('active_profile_id');

    if (profilesJson != null) {
      final List<dynamic> decoded = jsonDecode(profilesJson);
      _profiles = decoded.map((item) => UserProfile.fromJson(item)).toList();
    }

    _activeProfileId = activeId;
    
    if (_profiles.isNotEmpty && (_activeProfileId == null || !_profiles.any((p) => p.id == _activeProfileId))) {
      _activeProfileId = _profiles.first.id;
      await prefs.setString('active_profile_id', _activeProfileId!);
    }

    _isLoading = false;
    notifyListeners();
  }

  // AGGIUNTO PARAMETRO AVATAR
  Future<void> addProfile(String name, int age, String gender, double weight, String avatar) async {
    final newProfile = UserProfile(
      id: const Uuid().v4(),
      name: name,
      age: age,
      gender: gender,
      weight: weight,
      avatar: avatar,
    );

    _profiles.add(newProfile);
    
    if (_profiles.length == 1) {
      _activeProfileId = newProfile.id;
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('active_profile_id', _activeProfileId!);
    }

    await _saveToDisk();
    notifyListeners();
  }

  // AGGIUNTO PARAMETRO AVATAR
  Future<void> updateProfile(String id, String name, int age, String gender, double weight, String avatar) async {
    final index = _profiles.indexWhere((p) => p.id == id);
    if (index != -1) {
      _profiles[index].name = name;
      _profiles[index].age = age;
      _profiles[index].gender = gender;
      _profiles[index].weight = weight;
      _profiles[index].avatar = avatar; // <--- AGGIORNIAMO AVATAR
      await _saveToDisk();
      notifyListeners();
    }
  }

  Future<void> deleteProfile(String id) async {
    if (_profiles.length <= 1) return;

    _profiles.removeWhere((p) => p.id == id);
    
    if (_activeProfileId == id) {
      _activeProfileId = _profiles.first.id;
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString('active_profile_id', _activeProfileId!);
    }
    
    await _saveToDisk();
    notifyListeners();
  }

  Future<void> setActiveProfile(String id) async {
    _activeProfileId = id;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('active_profile_id', id);
    notifyListeners();
  }

  Future<void> _saveToDisk() async {
    final prefs = await SharedPreferences.getInstance();
    final String encoded = jsonEncode(_profiles.map((p) => p.toJson()).toList());
    await prefs.setString('profiles_db', encoded);
  }
}
