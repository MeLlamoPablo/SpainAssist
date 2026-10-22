import org.gradle.api.artifacts.type.ArtifactTypeDefinition
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.Base64
import java.util.zip.ZipFile

plugins {
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
}

/** A Gradle property (`-Pname=…` or `~/.gradle/gradle.properties`), else an environment variable. */
fun setting(property: String, env: String): String? =
    (providers.gradleProperty(property).orNull ?: providers.environmentVariable(env).orNull)?.takeIf { it.isNotBlank() }

/**
 * The version (README, "Releasing"): `-PappVersion=X.Y.Z` or `SA_APP_VERSION`, as the
 * `android/vX.Y.Z` tag gives it. versionCode is X*10000 + Y*100 + Z unless `-PversionCode` or
 * `SA_VERSION_CODE` sets it. Without them, the last values set by hand (0.2.1, 4).
 */
val appVersion = setting("appVersion", "SA_APP_VERSION")
val appVersionCode: Int =
    setting("versionCode", "SA_VERSION_CODE")?.let { it.toIntOrNull() ?: error("versionCode \"$it\" is not a number") }
        ?: appVersion?.let { version ->
            val parts = Regex("""(\d+)\.(\d+)\.(\d+)""").matchEntire(version)?.destructured?.toList()?.map(String::toInt)
                ?: error("appVersion \"$version\" is not X.Y.Z")
            val (major, minor, patch) = parts
            require(minor < 100 && patch < 100) { "appVersion $version: minor and patch must be below 100" }
            major * 10000 + minor * 100 + patch
        }
        ?: 4
// Builds 1 to 4 exist: Play refuses a versionCode it has seen, and installs refuse a downgrade.
require(appVersion == null && appVersionCode == 4 || appVersionCode > 4) { "versionCode $appVersionCode must be above 4" }

/**
 * Release signing with the upload key (Play App Signing re-signs for users). Nothing comes from
 * the repo: `SA_UPLOAD_KEYSTORE` (a path to the .jks, or the .jks in base64),
 * `SA_UPLOAD_KEYSTORE_PASSWORD`, `SA_UPLOAD_KEY_ALIAS` and `SA_UPLOAD_KEY_PASSWORD`, or the
 * Gradle properties `saUploadKeystore`, `saUploadKeystorePassword`, `saUploadKeyAlias` and
 * `saUploadKeyPassword`. With none of them, release builds are unsigned.
 */
val uploadKeystore = setting("saUploadKeystore", "SA_UPLOAD_KEYSTORE")
val uploadSecrets = mapOf(
    "SA_UPLOAD_KEYSTORE_PASSWORD" to setting("saUploadKeystorePassword", "SA_UPLOAD_KEYSTORE_PASSWORD"),
    "SA_UPLOAD_KEY_ALIAS" to setting("saUploadKeyAlias", "SA_UPLOAD_KEY_ALIAS"),
    "SA_UPLOAD_KEY_PASSWORD" to setting("saUploadKeyPassword", "SA_UPLOAD_KEY_PASSWORD"),
)
if (uploadKeystore != null || uploadSecrets.values.any { it != null }) {
    val missing = listOf("SA_UPLOAD_KEYSTORE").filter { uploadKeystore == null } + uploadSecrets.filterValues { it == null }.keys
    require(missing.isEmpty()) { "Release signing is half set up: missing ${missing.joinToString()}" }
}
// A base64 keystore is written under build/ when a release is signed (decodeUploadKeystore).
val uploadKeystoreBase64 = uploadKeystore?.takeUnless { file(it).isFile }?.also {
    require(it.length > 100 && it.matches(Regex("""[A-Za-z0-9+/=\s]+"""))) { "SA_UPLOAD_KEYSTORE: no file at $it" }
}
val uploadKeystoreFile = uploadKeystore?.let {
    if (uploadKeystoreBase64 == null) file(it) else layout.buildDirectory.file("upload-keystore/upload.jks").get().asFile
}

abstract class DecodeUploadKeystore : DefaultTask() {
    @get:Input
    abstract val base64: Property<String>

    @get:OutputFile
    abstract val keystore: RegularFileProperty

    @TaskAction
    fun decode() {
        val bytes = try {
            Base64.getDecoder().decode(base64.get().filterNot(Char::isWhitespace))
        } catch (e: IllegalArgumentException) {
            throw GradleException("SA_UPLOAD_KEYSTORE is not a .jks in base64", e)
        }
        keystore.get().asFile.writeBytes(bytes)
    }
}

android {
    namespace = "es.spainassist.firma"
    compileSdk = 37

    defaultConfig {
        applicationId = "es.spainassist.firma"
        minSdk = 26
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersion ?: "0.2.1"
        // The host of pairing links (App Links): the production relay.
        manifestPlaceholders["linkHost"] = "relay.spainassist.es"
    }

    buildFeatures { buildConfig = true }

    signingConfigs {
        if (uploadKeystoreFile != null) {
            create("upload") {
                storeFile = uploadKeystoreFile
                storePassword = uploadSecrets.getValue("SA_UPLOAD_KEYSTORE_PASSWORD")
                keyAlias = uploadSecrets.getValue("SA_UPLOAD_KEY_ALIAS")
                keyPassword = uploadSecrets.getValue("SA_UPLOAD_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("upload")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += setOf("META-INF/versions/**", "META-INF/*.kotlin_module")
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

/**
 * ML Kit and Google Play services keep the notices of the open-source code inside them in
 * `third_party_licenses.{json,txt}` at the root of their AARs, and those don't reach the APK.
 * This merges them into `assets/licenses/google_notices.txt` for the licences screen
 * (`AndroidLicenses.kt`): each notice starts with U+001E and its name on its own line.
 */
abstract class MergeGoogleNotices : DefaultTask() {
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val aars: ConfigurableFileCollection

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun merge() {
        val notices = sortedMapOf<String, String>(String.CASE_INSENSITIVE_ORDER)
        // {"Abseil": {"length": 11361, "start": 11}, …}: byte offsets into the .txt.
        val entry = Regex(""""((?:[^"\\]|\\.)+)"\s*:\s*\{([^}]*)\}""")
        for (aar in aars.files.filter { it.extension == "aar" }) {
            ZipFile(aar).use { zip ->
                val index = zip.getEntry("third_party_licenses.json") ?: return@use
                val text = zip.getInputStream(zip.getEntry("third_party_licenses.txt")).readBytes()
                val json = zip.getInputStream(index).readBytes().decodeToString()
                for (match in entry.findAll(json)) {
                    val (name, span) = match.destructured
                    val start = Regex(""""start"\s*:\s*(\d+)""").find(span)!!.groupValues[1].toInt()
                    val length = Regex(""""length"\s*:\s*(\d+)""").find(span)!!.groupValues[1].toInt()
                    notices.putIfAbsent(name, text.decodeToString(start, start + length).trim())
                }
            }
        }
        check(notices.isNotEmpty()) { "No third_party_licenses.json in the runtime AARs" }
        val out = outputDir.file("licenses/google_notices.txt").get().asFile
        out.parentFile.mkdirs()
        out.writeText(notices.entries.joinToString("") { (name, text) -> "\u001E$name\n$text\n" })
    }
}

androidComponents {
    onVariants { variant ->
        val name = variant.name.replaceFirstChar(Char::uppercaseChar)
        val notices = tasks.register<MergeGoogleNotices>("merge${name}GoogleNotices") {
            aars.from(
                variant.runtimeConfiguration.incoming.artifactView {
                    attributes { attribute(ArtifactTypeDefinition.ARTIFACT_TYPE_ATTRIBUTE, "aar") }
                    lenient(true)
                }.files,
            )
        }
        variant.sources.assets?.addGeneratedSourceDirectory(notices, MergeGoogleNotices::outputDir)
    }
}

if (uploadKeystoreBase64 != null) {
    val decode = tasks.register<DecodeUploadKeystore>("decodeUploadKeystore") {
        base64.set(uploadKeystoreBase64)
        keystore.set(uploadKeystoreFile)
    }
    // Every APK and bundle signing step comes after its validateSigning task.
    tasks.matching { it.name.startsWith("validateSigning") }.configureEach { dependsOn(decode) }
}

dependencies {
    implementation(projects.shared)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.core.ktx)
    implementation(libs.ktor.client.okhttp)
    implementation(libs.compose.runtime)
    implementation(libs.compose.foundation)
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.compose.components.resources)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode)
    // DNIe over NFC (PACE, CWA-14890). jmulticard-crypto bundles the BouncyCastle classes it needs.
    implementation(libs.jmulticard)
    implementation(libs.jmulticard.crypto)
    testImplementation(libs.junit)
}
