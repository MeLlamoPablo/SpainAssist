package es.spainassist.firma.android

import android.content.res.AssetManager
import es.spainassist.firma.app.Component
import es.spainassist.firma.app.LicenseGroup
import es.spainassist.firma.app.LicenseText
import es.spainassist.firma.app.Licenses
import es.spainassist.firma.app.ProprietaryComponent

/**
 * What the Android build ships, from its release runtime classpath (apps/mobile/NOTICE). Update
 * it when a dependency changes: `./gradlew :androidApp:dependencies --configuration
 * releaseRuntimeClasspath`, and each POM's licence.
 */
internal val ANDROID_LICENSES = Licenses(
    eupl = true,
    groups = listOf(
        LicenseGroup(
            LicenseText.Eupl12,
            listOf(
                Component(
                    "jmulticard 2.1",
                    "Copyright (C) 2012 Dirección General de Modernización Administrativa, Procedimientos e Impulso " +
                        "de la Administración Electrónica. Used under the EUPL; its files also offer the LGPL 2.1+ " +
                        "or the GPL 2.0+.",
                ),
            ),
        ),
        LicenseGroup(
            LicenseText.Mit,
            listOf(
                Licenses.OURS,
                Component("SLF4J API", "Copyright (c) 2004-2023 QOS.ch"),
                Component("Checker Framework qualifiers", "Copyright 2004-present by the Checker Framework developers"),
            ),
        ),
        LicenseGroup(LicenseText.BouncyCastle, listOf(Component("Bouncy Castle, inside jmulticard-crypto"))),
        LicenseGroup(LicenseText.Bsd3, listOf(Component("libyuv, inside CameraX"))),
        Licenses.FONTS,
        LicenseGroup(
            LicenseText.Apache2,
            listOf(
                "Kotlin", "kotlinx.coroutines", "kotlinx.serialization", "Ktor", "OkHttp", "Okio",
                "cryptography-kotlin", "Compose Multiplatform", "Jetpack Compose",
                "AndroidX (Activity, AppCompat, Core, Lifecycle, SavedState, CameraX, Media3, Window and others)",
                "Guava", "Dagger", "Firebase components", "Google Data Transport", "AutoValue annotations",
                "Error Prone annotations", "J2ObjC annotations", "JSR 305", "javax.inject", "Jakarta Inject",
                "JSpecify", "JetBrains annotations",
            ).map { Component(it) },
        ),
    ),
    proprietary = listOf(
        ProprietaryComponent("ML Kit barcode scanning", "https://developers.google.com/ml-kit/terms"),
        ProprietaryComponent("Google Play services", "https://developer.android.com/studio/terms"),
    ),
)

/** The notices merged from ML Kit's and Play services' AARs by the `merge…GoogleNotices` tasks. */
internal fun googleNotices(assets: AssetManager): List<Pair<String, String>> =
    assets.open("licenses/google_notices.txt").bufferedReader().use { it.readText() }
        .split(NOTICE_SEPARATOR)
        .filter { it.isNotBlank() }
        .map { it.substringBefore('\n') to it.substringAfter('\n') }

/** Starts each notice in the merged file (ASCII record separator), followed by its name line. */
internal const val NOTICE_SEPARATOR = '\u001E'
