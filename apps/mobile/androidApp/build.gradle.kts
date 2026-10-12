import org.gradle.api.artifacts.type.ArtifactTypeDefinition
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.zip.ZipFile

plugins {
    alias(libs.plugins.androidApplication)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
}

android {
    namespace = "es.spainassist.firma"
    compileSdk = 37

    defaultConfig {
        applicationId = "es.spainassist.firma"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
        // The host of pairing links (App Links): the production relay.
        manifestPlaceholders["linkHost"] = "relay.2-31-6-160.sslip.io"
    }

    buildFeatures { buildConfig = true }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
