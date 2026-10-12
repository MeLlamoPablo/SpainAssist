package es.spainassist.firma.app

/** A licence whose full text the app ships, under composeResources/files/licenses. */
enum class LicenseText(val title: String, val path: String) {
    Eupl12("European Union Public Licence 1.2", "files/licenses/EUPL-1.2.txt"),
    Mit("MIT License", "files/licenses/MIT.txt"),
    Apache2("Apache License 2.0", "files/licenses/Apache-2.0.txt"),
    BouncyCastle("Bouncy Castle License", "files/licenses/BouncyCastle.txt"),

    /** With libyuv's copyright line (the only BSD-3-Clause component). */
    Bsd3("BSD 3-Clause License", "files/licenses/BSD-3-Clause.txt"),
}

/** A third-party component; [notice] is the copyright line its licence asks us to keep. */
data class Component(val name: String, val notice: String? = null)

data class LicenseGroup(val license: LicenseText, val components: List<Component>)

/** A library that isn't open source, and where its terms are. */
data class ProprietaryComponent(val name: String, val termsUrl: String)

/** What a build ships, for the licences screen ([Platform.licenses]). apps/mobile/NOTICE explains it. */
data class Licenses(
    /** The build bundles jmulticard, so the app as a whole is distributed under the EUPL-1.2. */
    val eupl: Boolean,
    val groups: List<LicenseGroup>,
    val proprietary: List<ProprietaryComponent>,
) {
    companion object {
        /** The app's complete source, for every release. */
        const val SOURCE_URL = "https://github.com/MeLlamoPablo/SpainAssistant"
        const val JMULTICARD_SOURCE_URL = "https://github.com/ctt-gob-es/jmulticard"

        /** The EUPL-1.2 in every official EU language. */
        const val EUPL_URL = "https://eur-lex.europa.eu/eli/dec_impl/2017/863/oj"

        /** Our own code, on every platform. */
        val OURS = Component("Spain Assist", "Copyright (c) 2026 Pablo Rodríguez Caballero")
    }
}
