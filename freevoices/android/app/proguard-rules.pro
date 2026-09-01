# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ─── FreeVoices ───────────────────────────────────────────────────────────────
#
# This file is intentionally almost empty. `minifyEnabled` is false for the first
# release (see app/build.gradle for why), so nothing here is applied yet.
#
# When you do enable minification, note that most of what Capacitor needs is
# already handled: node_modules/@capacitor/android/capacitor/build.gradle
# declares `consumerProguardFiles 'proguard-rules.pro'`, and those rules keep
# classes annotated @CapacitorPlugin, classes extending com.getcapacitor.Plugin,
# @NativePlugin classes, and Cordova plugin classes. That covers the
# Class.forName lookup in com.getcapacitor.PluginManager.
#
# Keep the launcher activity by name, since it is referenced from the manifest
# as a string rather than a type.
-keep class za.co.freevoices.app.MainActivity { *; }
