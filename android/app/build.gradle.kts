plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.example.signlang"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.example.signlang"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = maxOf(flutter.minSdkVersion, 24)
        ndk {
            abiFilters += "arm64-v8a"
        }
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    androidResources {
        noCompress += listOf("bin", "onnx", "gzip")
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

dependencies {
    implementation(files("../../tool/vendor/onnxruntime-android-1.24.3.aar"))
    testImplementation("junit:junit:4.13.2")
}

tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    doFirst {
        val required = listOf(
            "src/main/assets/models/ggml-base-q5_1.bin",
            "src/main/assets/models/vsl224-rgb.onnx",
            "src/main/assets/models/labels.json",
            "src/main/assets/signs/dictionary.json",
            "src/main/assets/avatar/index.html",
            "src/main/assets/avatar/models/avatar.vrm",
            "src/main/jniLibs/arm64-v8a/libsignlang_whisper.so",
            "../../tool/vendor/onnxruntime-android-1.24.3.aar",
        )
        val missing = required.filterNot { file(it).isFile }
        check(missing.isEmpty()) { "Missing offline release assets: ${missing.joinToString()}. See README.md." }
    }
}
