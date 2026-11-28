import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'offline_screens.dart';
import 'paper.dart';

void main() => runApp(const SignLangApp());

class SignLangApp extends StatefulWidget {
  const SignLangApp({super.key});

  @override
  State<SignLangApp> createState() => _SignLangAppState();
}

class _SignLangAppState extends State<SignLangApp> {
  late final OfflineEvents _events;

  @override
  void initState() {
    super.initState();
    _events = OfflineEvents();
  }

  @override
  void dispose() {
    _events.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    const buttonSize = Size(0, 50);
    final scheme = ColorScheme.fromSeed(seedColor: teal).copyWith(
      surface: paper,
      onSurface: ink,
      primary: const Color(0xff396f65),
      secondaryContainer: const Color(0xffe2ede5),
      onSecondaryContainer: ink,
      outline: pencil,
    );
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'SignLang',
      theme: ThemeData(
        colorScheme: scheme,
        scaffoldBackgroundColor: Colors.transparent,
        appBarTheme: const AppBarTheme(
          backgroundColor: paper,
          foregroundColor: ink,
          surfaceTintColor: Colors.transparent,
          titleTextStyle: TextStyle(
            color: ink,
            fontSize: 21,
            fontWeight: FontWeight.bold,
          ),
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            minimumSize: buttonSize,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
            ),
          ),
        ),
        outlinedButtonTheme: const OutlinedButtonThemeData(
          style: ButtonStyle(minimumSize: WidgetStatePropertyAll(buttonSize)),
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: paper,
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
          alignLabelWithHint: true,
        ),
        navigationBarTheme: const NavigationBarThemeData(
          backgroundColor: paper,
          indicatorColor: Color(0xffdcebe2),
          height: 66,
        ),
      ),
      home: _Dashboard(events: _events),
    );
  }
}

class _Dashboard extends StatefulWidget {
  const _Dashboard({required this.events});

  final OfflineEvents events;

  @override
  State<_Dashboard> createState() => _DashboardState();
}

class _DashboardState extends State<_Dashboard> {
  int _selected = 0;

  void _select(int index) => setState(() => _selected = index);

  Future<void> _serverSettings() async {
    final server = await offline.invokeMethod<String>('apiServer');
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (_) => _ServerSettings(server ?? ''),
    );
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: _selected == 0,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop && _selected != 0) _select(0);
      },
      child: PaperBackground(
        child: Scaffold(
          body: switch (_selected) {
            1 => SpeechScreen(widget.events.stream),
            2 => CameraScreen(widget.events.stream),
            _ => Scaffold(
              appBar: AppBar(
                title: const Text('Tổng quan'),
                actions: [
                  IconButton(
                    onPressed: _serverSettings,
                    icon: const Icon(Icons.settings_outlined),
                    tooltip: 'Kết nối máy chủ',
                  ),
                  const SizedBox(width: 8),
                ],
              ),
              body: SafeArea(
                top: false,
                child: ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    SketchCard(
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  'Xin chào!',
                                  style: Theme.of(context)
                                      .textTheme
                                      .headlineMedium
                                      ?.copyWith(
                                        fontWeight: FontWeight.w800,
                                        color: ink,
                                      ),
                                ),
                                const SizedBox(height: 6),
                                const Text(
                                  'Giao tiếp bằng giọng nói và ngôn ngữ ký hiệu.',
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 16),
                          const Icon(
                            Icons.sign_language_rounded,
                            color: teal,
                            size: 56,
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 20),
                    _Entry(
                      title: 'Dịch giọng nói',
                      subtitle: 'Giọng nói sang ký hiệu',
                      icon: Icons.mic_rounded,
                      color: rose,
                      onTap: () => _select(1),
                    ),
                    const SizedBox(height: 12),
                    _Entry(
                      title: 'Nhận diện',
                      subtitle: 'Camera sang văn bản',
                      icon: Icons.videocam_rounded,
                      color: sky,
                      onTap: () => _select(2),
                    ),
                  ],
                ),
              ),
            ),
          },
          bottomNavigationBar: NavigationBar(
            selectedIndex: _selected,
            onDestinationSelected: _select,
            destinations: const [
              NavigationDestination(
                icon: Icon(Icons.pie_chart_outline),
                label: 'Tổng quan',
              ),
              NavigationDestination(
                icon: Icon(Icons.mic_none_rounded),
                label: 'Dịch',
              ),
              NavigationDestination(
                icon: Icon(Icons.camera_alt_outlined),
                label: 'Camera',
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Entry extends StatelessWidget {
  const _Entry({
    required this.title,
    required this.subtitle,
    required this.icon,
    required this.color,
    required this.onTap,
  });

  final String title;
  final String subtitle;
  final IconData icon;
  final Color color;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scale = MediaQuery.textScalerOf(context).scale(16) / 16;
    return SizedBox(
      height: 36.0 + 80.0 * scale.clamp(1.0, double.infinity),
      child: SketchCard(
        onTap: onTap,
        child: Row(
          children: [
            Container(
              width: 48,
              height: 48,
              decoration: BoxDecoration(
                color: color,
                borderRadius: BorderRadius.circular(14),
              ),
              child: Icon(icon, color: Colors.white),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.titleMedium
                        ?.copyWith(fontWeight: FontWeight.bold, height: 1.25),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    subtitle,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodyMedium
                        ?.copyWith(height: 1.25),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ServerSettings extends StatefulWidget {
  const _ServerSettings(this.server);

  final String server;

  @override
  State<_ServerSettings> createState() => _ServerSettingsState();
}

class _ServerSettingsState extends State<_ServerSettings> {
  late final _url = TextEditingController(text: widget.server);
  String? _error;

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    try {
      await offline.invokeMethod<void>('setApiServer', _url.text);
      if (mounted) Navigator.pop(context);
    } on PlatformException catch (error) {
      if (mounted) setState(() => _error = error.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Kết nối máy chủ'),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Khi kết nối được, bản ghi và clip ký hiệu sẽ được xử lý trên máy chủ. Để trống nếu chỉ muốn xử lý trên thiết bị.',
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _url,
              keyboardType: TextInputType.url,
              decoration: InputDecoration(
                labelText: 'URL HTTPS',
                errorText: _error,
              ),
              onSubmitted: (_) => _save(),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Hủy'),
        ),
        FilledButton(onPressed: _save, child: const Text('Lưu')),
      ],
    );
  }
}
