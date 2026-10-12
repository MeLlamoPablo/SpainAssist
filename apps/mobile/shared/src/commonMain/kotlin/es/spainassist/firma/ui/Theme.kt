package es.spainassist.firma.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import es.spainassist.firma.resources.Res
import es.spainassist.firma.resources.instrument_serif_italic
import es.spainassist.firma.resources.instrument_serif_regular
import es.spainassist.firma.resources.inter_medium
import es.spainassist.firma.resources.inter_regular
import es.spainassist.firma.resources.inter_semibold
import org.jetbrains.compose.resources.Font

/** The desktop's palette (apps/desktop/src/renderer/src/design/color-tokens.json). */
@Immutable
data class FirmaColors(
    val surface: Color,
    val surface2: Color,
    val surface3: Color,
    val line: Color,
    val fg: Color,
    val fgMuted: Color,
    val fgSubtle: Color,
    val accent: Color,
    val accentFg: Color,
    val accentText: Color,
    val accentSoft: Color,
    val doneFg: Color,
    val doneBg: Color,
    val attentionFg: Color,
    val attentionBg: Color,
    val blockedFg: Color,
    val blockedBg: Color,
    val flagRed: Color,
    val flagYellow: Color,
    val flagOutline: Color,
)

private val Light = FirmaColors(
    surface = Color(0xFFFFFFFF),
    surface2 = Color(0xFFFCFBF9),
    surface3 = Color(0xFFF9F7F3),
    line = Color(0xFFE5E1DC),
    fg = Color(0xFF28211D),
    fgMuted = Color(0xFF605954),
    fgSubtle = Color(0xFF79736E),
    accent = Color(0xFF28211D),
    accentFg = Color(0xFFFFFFFF),
    accentText = Color(0xFF28211D),
    accentSoft = Color(0xFFF4F0EC),
    doneFg = Color(0xFF0A693C),
    doneBg = Color(0xFFE6FAEC),
    attentionFg = Color(0xFF884D01),
    attentionBg = Color(0xFFFFF5DB),
    blockedFg = Color(0xFFB02B27),
    blockedBg = Color(0xFFFFEFEE),
    flagRed = Color(0xFFC60B1E),
    flagYellow = Color(0xFFFFC400),
    flagOutline = Color(0xFFD4D0CB),
)

private val Dark = FirmaColors(
    surface = Color(0xFF1E1B19),
    surface2 = Color(0xFF24211E),
    surface3 = Color(0xFF2E2A27),
    line = Color(0xFF312D2A),
    fg = Color(0xFFEDEBE7),
    fgMuted = Color(0xFFB5B0AB),
    fgSubtle = Color(0xFF96918C),
    accent = Color(0xFFEDEBE7),
    accentFg = Color(0xFF1E1B19),
    accentText = Color(0xFFEDEBE7),
    accentSoft = Color(0xFF2E2A27),
    doneFg = Color(0xFF8ED8A8),
    doneBg = Color(0xFF132C20),
    attentionFg = Color(0xFFF5C66D),
    attentionBg = Color(0xFF3A270B),
    blockedFg = Color(0xFFF8A59B),
    blockedBg = Color(0xFF3E1F1B),
    flagRed = Color(0xFFC60B1E),
    flagYellow = Color(0xFFFFC400),
    flagOutline = Color(0xFFFFFFFF),
)

val LocalFirmaColors = staticCompositionLocalOf { Light }

/** Inter: every text but the wordmark. */
@Composable
internal fun interFamily() = FontFamily(
    Font(Res.font.inter_regular, FontWeight.Normal),
    Font(Res.font.inter_medium, FontWeight.Medium),
    Font(Res.font.inter_semibold, FontWeight.SemiBold),
)

/** Instrument Serif: the "Spain Assist" wordmark. */
@Composable
internal fun brandFamily() = FontFamily(
    Font(Res.font.instrument_serif_regular, FontWeight.Normal, FontStyle.Normal),
    Font(Res.font.instrument_serif_italic, FontWeight.Normal, FontStyle.Italic),
)

@Composable
fun FirmaTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val colors = if (dark) Dark else Light
    val scheme = (if (dark) darkColorScheme() else lightColorScheme()).copy(
        primary = colors.accent,
        onPrimary = colors.accentFg,
        background = colors.surface,
        surface = colors.surface,
        surfaceVariant = colors.surface3,
        surfaceContainer = colors.surface,
        onBackground = colors.fg,
        onSurface = colors.fg,
        onSurfaceVariant = colors.fgMuted,
        outline = colors.line,
        error = colors.blockedFg,
    )
    val inter = interFamily()
    val typography = Typography().let { t ->
        fun TextStyle.inter() = copy(fontFamily = inter, letterSpacing = 0.sp)
        Typography(
            displayLarge = t.displayLarge.inter(),
            displayMedium = t.displayMedium.inter(),
            displaySmall = t.displaySmall.inter(),
            headlineLarge = t.headlineLarge.inter(),
            headlineMedium = t.headlineMedium.inter(),
            headlineSmall = t.headlineSmall.inter(),
            titleLarge = t.titleLarge.inter(),
            titleMedium = t.titleMedium.inter(),
            titleSmall = t.titleSmall.inter(),
            bodyLarge = t.bodyLarge.inter(),
            bodyMedium = t.bodyMedium.inter(),
            bodySmall = t.bodySmall.inter(),
            labelLarge = t.labelLarge.inter(),
            labelMedium = t.labelMedium.inter(),
            labelSmall = t.labelSmall.inter(),
        )
    }
    CompositionLocalProvider(LocalFirmaColors provides colors) {
        MaterialTheme(colorScheme = scheme, typography = typography, content = content)
    }
}
