#include <algorithm>
#include <jni.h>
#include <string>
#include <vector>
#include "whisper.h"

extern "C" JNIEXPORT jlong JNICALL
Java_com_example_signlang_Whisper_open(JNIEnv *env, jobject, jstring path) {
    auto params = whisper_context_default_params();
    params.use_gpu = false;
    const char *filename = env->GetStringUTFChars(path, nullptr);
    if (!filename) return 0;
    auto *context = whisper_init_from_file_with_params(filename, params);
    env->ReleaseStringUTFChars(path, filename);
    return reinterpret_cast<jlong>(context);
}

extern "C" JNIEXPORT void JNICALL
Java_com_example_signlang_Whisper_close(JNIEnv *, jobject, jlong handle) {
    if (handle) whisper_free(reinterpret_cast<whisper_context *>(handle));
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_example_signlang_Whisper_transcribe(JNIEnv *env, jobject, jlong handle, jshortArray samples) {
    auto *context = reinterpret_cast<whisper_context *>(handle);
    if (!context) return nullptr;

    const auto size = env->GetArrayLength(samples);
    std::vector<jshort> pcm(size);
    env->GetShortArrayRegion(samples, 0, size, pcm.data());
    if (env->ExceptionCheck()) return nullptr;
    std::vector<float> audio(size);
    std::transform(pcm.begin(), pcm.end(), audio.begin(),
                   [](jshort sample) { return sample / 32768.0f; });
    auto config = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    config.language = "vi";
    config.translate = false;
    config.n_threads = 4;
    config.no_context = true;
    config.print_timestamps = false;
    config.print_progress = false;
    config.print_realtime = false;
    config.print_special = false;
    if (whisper_full(context, config, audio.data(), size) != 0) return nullptr;

    std::string text;
    for (int i = 0; i < whisper_full_n_segments(context); ++i) {
        text += whisper_full_get_segment_text(context, i);
    }
    auto result = env->NewByteArray(static_cast<jsize>(text.size()));
    if (result && !text.empty()) {
        env->SetByteArrayRegion(result, 0, static_cast<jsize>(text.size()),
                                reinterpret_cast<const jbyte *>(text.data()));
    }
    return result;
}

