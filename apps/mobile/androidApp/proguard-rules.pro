# jmulticard looks some classes up by name (TextInputCallback fallback, ASN.1 structures) and
# its bundled BouncyCastle registers algorithms through reflection: keep them whole.
-keep class es.gob.jmulticard.** { *; }
-keep class org.bouncycastle.** { *; }
-dontwarn org.bouncycastle.**
-dontwarn es.gob.jmulticard.**
-dontwarn javax.naming.**
-dontwarn java.awt.**
-dontwarn javax.imageio.**

# kotlinx.serialization: the protocol messages are looked up through generated serializers.
-keepclassmembers class es.spainassist.firma.protocol.** {
    *** Companion;
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class es.spainassist.firma.protocol.**$$serializer { *; }

# Ktor / OkHttp
-dontwarn org.slf4j.**
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
