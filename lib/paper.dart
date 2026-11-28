import 'package:flutter/material.dart';

const ink = Color(0xff2c1810);
const paper = Color(0xfffaf6ef);
const pencil = Color(0xffc8bfb0);
const rose = Color(0xffc87a72);
const sky = Color(0xff6a9bba);
const teal = Color(0xff4a8f84);

class PaperBackground extends StatelessWidget {
  const PaperBackground({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xfff5efe6), Color(0xffebe4d4), Color(0xffe5dccb)],
        ),
      ),
      child: DecoratedBox(
        decoration: const BoxDecoration(
          gradient: RadialGradient(
            center: Alignment(-.85, -.7),
            radius: .8,
            colors: [Color(0x2860b4a8), Color(0x0060b4a8)],
          ),
        ),
        child: child,
      ),
    );
  }
}

class SketchCard extends StatelessWidget {
  const SketchCard({required this.child, this.onTap, super.key});

  final Widget child;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: const Color(0xe6fffcf5),
      elevation: 1,
      shadowColor: const Color(0x302c1810),
      shape: RoundedRectangleBorder(
        side: const BorderSide(color: pencil),
        borderRadius: BorderRadius.circular(20),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(padding: const EdgeInsets.all(16), child: child),
      ),
    );
  }
}
