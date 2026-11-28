import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'offline_logic.dart';
import 'paper.dart';

const offline = MethodChannel('signlang/offline');

typedef OfflineEvent = ({String kind, String event, Object? value});

class OfflineEvents {
  OfflineEvents() {
    offline.setMethodCallHandler((call) async {
      if (call.method == 'event') {
        final data = call.arguments as Map;
        _controller.add((
          kind: data['kind'] as String,
          event: data['event'] as String,
          value: data['value'],
        ));
      }
    });
  }

  final _controller = StreamController<OfflineEvent>.broadcast();

  Stream<OfflineEvent> get stream => _controller.stream;

  void dispose() {
    offline.setMethodCallHandler(null);
    unawaited(_controller.close());
  }
}

class _Preview extends StatelessWidget {
  const _Preview({required this.kind, required this.ratio});

  final String kind;
  final double ratio;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(20),
      child: AspectRatio(
        aspectRatio: ratio,
        child: AndroidView(viewType: 'signlang/$kind'),
      ),
    );
  }
}

class _Status extends StatelessWidget {
  const _Status(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      liveRegion: true,
      child: Text(text, style: Theme.of(context).textTheme.bodyLarge),
    );
  }
}

class SpeechScreen extends StatefulWidget {
  const SpeechScreen(this.events, {super.key});
  final Stream<OfflineEvent> events;

  @override
  State<SpeechScreen> createState() => _SpeechScreenState();
}

class _SpeechScreenState extends State<SpeechScreen> {
  final _text = TextEditingController();
  late final StreamSubscription<OfflineEvent> _subscription;
  SignDictionary? _dictionary;
  var _status = 'Bấm ghi âm hoặc nhập câu tiếng Việt.';
  var _avatarStatus = 'Đang khởi tạo avatar 3D…';
  var _unknown = <String>[];
  var _recording = false;
  var _busy = false;
  var _micDenied = false;
  final _history = <String>[];

  @override
  void initState() {
    super.initState();
    _subscription = widget.events.listen((message) {
      if (message.kind == 'avatar' && message.event == 'status') {
        setState(() => _avatarStatus = message.value as String);
      }
      if (message.kind == 'speech') {
        if (message.event == 'interrupted') {
          setState(() {
            _recording = false;
            _status = 'Ghi âm đã dừng. Bấm ghi âm để thử lại.';
          });
        } else if (_recording || _busy) {
          setState(() => _status = message.value as String);
        }
      }
    });
  }

  Future<void> _toggleMic() async {
    FocusScope.of(context).unfocus();
    final wasRecording = _recording;
    setState(() {
      _busy = true;
      _micDenied = false;
      _status = wasRecording
          ? 'Đang nhận dạng giọng nói…'
          : 'Đang xin quyền mic…';
      if (wasRecording) _recording = false;
    });
    try {
      if (wasRecording) {
        final result = await offline.invokeMethod<String>('micStop');
        if (!mounted) return;
        if (result != null && result.isNotEmpty) {
          _text.text = result;
          _remember(result);
          _unknown = [];
          _status = 'Bạn có thể sửa văn bản rồi phát ký hiệu.';
        } else {
          _status = 'Chưa nhận được lời nói. Hãy ghi âm lại.';
        }
      } else {
        await offline.invokeMethod<void>('micStart');
        if (!mounted) return;
        _recording = true;
        _status = 'Đang ghi âm. Bấm Nhận dạng khi nói xong.';
      }
    } on PlatformException catch (error) {
      if (!mounted) return;
      _micDenied = error.code == 'permission';
      _status = error.message ?? 'Không xử lý được bản ghi. Hãy thử lại.';
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _remember(String text) {
    _history.remove(text);
    _history.insert(0, text);
    if (_history.length > 10) _history.removeLast();
  }

  Future<void> _play() async {
    FocusScope.of(context).unfocus();
    final input = _text.text.trim();
    if (input.isEmpty) {
      setState(() => _status = 'Nhập văn bản hoặc ghi âm trước khi phát.');
      return;
    }
    setState(() {
      _busy = true;
      _status = 'Đang dịch…';
    });
    try {
      final apiTokens = parseApiSigns(
        await offline.invokeMethod<String>('apiTextSigns', input),
      );
      List<SignToken> tokens;
      if (apiTokens != null) {
        tokens = apiTokens;
      } else {
        _dictionary ??= SignDictionary.fromJson(
          (await offline.invokeMethod<String>('dictionary'))!,
        );
        final composed = await offline.invokeMethod<String>('normalize', input);
        tokens = _dictionary!.tokenize(composed ?? input);
      }
      final signs = tokens.where((token) => token.gloss != null).toList();
      if (!mounted) return;
      _unknown = tokens
          .where((token) => token.gloss == null)
          .map((token) => token.vi)
          .toSet()
          .toList();
      if (signs.isEmpty) {
        _status = 'Chưa có dữ liệu ký hiệu cho nội dung này.';
        return;
      }
      _remember(input);
      _status = apiTokens == null
          ? 'Đã dịch trên thiết bị.'
          : 'Đã dịch qua máy chủ.';
      await offline.invokeMethod<void>(
        'play',
        signs.map((sign) => sign.toJson(online: apiTokens != null)).toList(),
      );
    } on PlatformException catch (error) {
      if (mounted) {
        _status = error.message ?? 'Không phát được ký hiệu. Hãy thử lại.';
      }
    } on FormatException {
      if (mounted) _status = 'Không đọc được từ điển ký hiệu.';
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    unawaited(_subscription.cancel());
    unawaited(offline.invokeMethod<void>('micCancel'));
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Giọng nói sang ký hiệu')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SketchCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Center(
                  child: FilledButton(
                    style: FilledButton.styleFrom(
                      shape: const CircleBorder(),
                      backgroundColor: _recording
                          ? const Color(0xff94463e)
                          : rose,
                      foregroundColor: Colors.white,
                      minimumSize: const Size.square(74),
                    ),
                    onPressed: _busy ? null : _toggleMic,
                    child: Tooltip(
                      message: _recording ? 'Nhận dạng' : 'Ghi âm',
                      child: Icon(
                        _recording ? Icons.mic_off_rounded : Icons.mic_rounded,
                        size: 32,
                      ),
                    ),
                  ),
                ),
                const SizedBox(height: 10),
                Center(child: _Status(_status)),
                if (_micDenied)
                  TextButton(
                    onPressed: () => offline.invokeMethod<void>('settings'),
                    child: const Text('Mở cài đặt quyền'),
                  ),
                const SizedBox(height: 16),
                const Center(child: Text('hoặc nhập văn bản')),
                const SizedBox(height: 8),
                TextField(
                  controller: _text,
                  minLines: 1,
                  maxLines: 4,
                  maxLength: 600,
                  decoration: const InputDecoration(
                    hintText: 'Nhập câu tiếng Việt...',
                  ),
                  onChanged: (_) {
                    if (_unknown.isNotEmpty) setState(_unknown.clear);
                  },
                ),
                FilledButton.icon(
                  onPressed: _busy || _recording ? null : _play,
                  icon: const Icon(Icons.send_rounded),
                  label: const Text('Dịch'),
                ),
                if (_unknown.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  _Status('Chưa có dữ liệu: ${_unknown.join(', ')}'),
                ],
              ],
            ),
          ),
          const SizedBox(height: 16),
          SketchCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  '3D Avatar',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 8),
                const _Preview(kind: 'avatar', ratio: 1.26),
                const SizedBox(height: 8),
                _Status(_avatarStatus),
                if (_avatarStatus.startsWith('Không'))
                  TextButton(
                    onPressed: () {
                      setState(() => _avatarStatus = 'Đang tải lại avatar 3D…');
                      unawaited(offline.invokeMethod<void>('reloadAvatar'));
                    },
                    child: const Text('Tải lại avatar'),
                  ),
                TextButton.icon(
                  onPressed: () => offline.invokeMethod<void>('stop'),
                  icon: const Icon(Icons.stop_rounded),
                  label: const Text('Dừng phát'),
                ),
              ],
            ),
          ),
          if (_history.isNotEmpty) ...[
            const SizedBox(height: 16),
            SketchCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      const Expanded(child: Text('Lịch sử nhận dạng')),
                      TextButton(
                        onPressed: () => setState(_history.clear),
                        child: const Text('Xóa'),
                      ),
                    ],
                  ),
                  for (final text in _history)
                    ListTile(
                      dense: true,
                      title: Text(text),
                      trailing: const Icon(Icons.replay_rounded),
                      onTap: _busy || _recording
                          ? null
                          : () {
                              _text.text = text;
                              unawaited(_play());
                            },
                    ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class CameraScreen extends StatefulWidget {
  const CameraScreen(this.events, {super.key});
  final Stream<OfflineEvent> events;

  @override
  State<CameraScreen> createState() => _CameraScreenState();
}

class _CameraScreenState extends State<CameraScreen> {
  final _recognized = RecognizedSigns();
  final _draft = TextEditingController();
  late final StreamSubscription<OfflineEvent> _subscription;
  var _active = false;
  var _starting = false;
  var _permissionDenied = false;
  var _status = 'Bấm mở camera để bắt đầu.';
  var _lastResult = '';
  var _suggesting = false;
  var _revision = 0;

  @override
  void initState() {
    super.initState();
    _subscription = widget.events
        .where((event) => event.kind == 'camera')
        .listen((message) {
          setState(() {
            switch (message.event) {
              case 'active':
                _active = message.value as bool;
                _starting = false;
              case 'status':
                _status = message.value as String;
              case 'permission':
                _permissionDenied = message.value == false;
              case 'prediction':
                final data = message.value as Map;
                final word = data['word'] as String;
                final confidence = data['confidence'] as double;
                final margin = data['margin'] as double;
                final percent = '${(confidence * 100).round()}%';
                if (confidence < .45 || margin < .12) {
                  _lastResult =
                      'Chưa đủ chắc chắn: $word ($percent). Hãy thử lại.';
                } else {
                  if (_recognized.accept(
                    data['event'] as String,
                    word,
                    confidence,
                    margin,
                  )) {
                    _revision++;
                  }
                  _lastResult = '$word ($percent)';
                }
            }
          });
        });
  }

  Future<void> _toggleCamera() async {
    final wasActive = _active;
    setState(() {
      _starting = true;
      _permissionDenied = false;
      if (!wasActive) {
        _lastResult = '';
        _status = 'Đang xin quyền và mở camera…';
      }
    });
    try {
      await offline.invokeMethod<void>(
        wasActive ? 'cameraStop' : 'cameraStart',
      );
    } on PlatformException catch (error) {
      if (!mounted) return;
      setState(() {
        _starting = false;
        _status = error.message ?? 'Lỗi camera. Hãy thử lại.';
      });
    }
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: _draft.text.trim()));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Đã sao chép câu tiếng Việt.')),
    );
  }

  Future<void> _suggest() async {
    final words = _recognized.words;
    final revision = _revision;
    setState(() => _suggesting = true);
    String? remote;
    try {
      remote = await offline.invokeMethod<String>('apiSentence', words);
    } on PlatformException {
      // Preserve the same local fallback if the channel cannot reach the API.
    }
    if (!mounted) return;
    setState(() {
      _suggesting = false;
      if (revision == _revision) _draft.text = remote ?? proposeSentence(words);
    });
  }

  Future<void> _switchCamera() async {
    setState(() {
      _starting = true;
      _status = 'Đang đổi camera…';
    });
    try {
      await offline.invokeMethod<void>('cameraSwitch');
    } on PlatformException {
      if (mounted) {
        setState(() {
          _starting = false;
          _status = 'Không đổi được camera. Hãy thử lại.';
        });
      }
    }
  }

  @override
  void dispose() {
    unawaited(_subscription.cancel());
    _draft.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final words = _recognized.words;
    return Scaffold(
      appBar: AppBar(title: const Text('Nhận diện ký hiệu')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
        children: [
          Stack(
            alignment: Alignment.center,
            children: [
              const _Preview(kind: 'camera', ratio: 1.22),
              if (!_active)
                const IgnorePointer(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        Icons.videocam_off_outlined,
                        color: Colors.white70,
                        size: 42,
                      ),
                      SizedBox(height: 8),
                      Text(
                        'Camera đang tắt',
                        style: TextStyle(color: Colors.white70),
                      ),
                    ],
                  ),
                ),
            ],
          ),
          const SizedBox(height: 12),
          const Text('Giữ tay trong khung hình và ngắt nhẹ giữa các ký hiệu.'),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: _starting ? null : _toggleCamera,
                  icon: Icon(
                    _active
                        ? Icons.stop_circle_outlined
                        : Icons.videocam_outlined,
                  ),
                  label: Text(_active ? 'Dừng dịch' : 'Mở camera'),
                ),
              ),
              const SizedBox(width: 8),
              IconButton.outlined(
                tooltip: 'Đổi camera',
                onPressed: _active && !_starting ? _switchCamera : null,
                icon: const Icon(Icons.cameraswitch_outlined),
              ),
            ],
          ),
          const SizedBox(height: 8),
          _Status(_status),
          if (_permissionDenied)
            TextButton(
              onPressed: () => offline.invokeMethod<void>('settings'),
              child: const Text('Mở cài đặt quyền'),
            ),
          if (_lastResult.isNotEmpty) SketchCard(child: _Status(_lastResult)),
          const SizedBox(height: 16),
          SketchCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'Chuỗi nhận diện gốc',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                const SizedBox(height: 6),
                if (words.isEmpty)
                  const Text('Chưa có ký hiệu.')
                else
                  Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    children: [
                      for (final word in words) Chip(label: Text(word)),
                    ],
                  ),
              ],
            ),
          ),
          if (words.isNotEmpty)
            Wrap(
              spacing: 12,
              children: [
                TextButton(
                  onPressed: () => setState(() {
                    _recognized.removeLast();
                    _revision++;
                  }),
                  child: const Text('Bỏ từ cuối'),
                ),
                TextButton(
                  onPressed: () => setState(() {
                    _recognized.clear();
                    _revision++;
                    _draft.clear();
                    _lastResult = '';
                  }),
                  child: const Text('Xóa chuỗi'),
                ),
              ],
            ),
          const SizedBox(height: 12),
          FilledButton.tonal(
            onPressed: words.isEmpty || _suggesting ? null : _suggest,
            child: Text(_suggesting ? 'Đang tạo câu…' : 'Tạo câu có nghĩa'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _draft,
            minLines: 2,
            maxLines: 4,
            onChanged: (_) => setState(() => _revision++),
            decoration: const InputDecoration(labelText: 'Câu tiếng Việt'),
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            onPressed: _draft.text.trim().isEmpty ? null : _copy,
            icon: const Icon(Icons.copy_outlined),
            label: const Text('Sao chép câu'),
          ),
        ],
      ),
    );
  }
}
