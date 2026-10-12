package es.spainassist.firma.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

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
    val accentText: Color,
    val accentSoft: Color,
    val doneFg: Color,
    val doneBg: Color,
    val attentionFg: Color,
    val attentionBg: Color,
    val blockedFg: Color,
    val blockedBg: Color,
)

private val Light = FirmaColors(
    surface = Color(0xFFFFFFFF),
    surface2 = Color(0xFFFCFBF9),
    surface3 = Color(0xFFF9F7F3),
    line = Color(0xFFE5E1DC),
    fg = Color(0xFF28211D),
    fgMuted = Color(0xFF605954),
    fgSubtle = Color(0xFF79736E),
    accent = Color(0xFFB04E35),
    accentText = Color(0xFF913D2B),
    accentSoft = Color(0xFFFEF5F0),
    doneFg = Color(0xFF0A693C),
    doneBg = Color(0xFFE6FAEC),
    attentionFg = Color(0xFF884D01),
    attentionBg = Color(0xFFFFF5DB),
    blockedFg = Color(0xFFB02B27),
    blockedBg = Color(0xFFFFEFEE),
)

private val Dark = FirmaColors(
    surface = Color(0xFF1E1B19),
    surface2 = Color(0xFF24211E),
    surface3 = Color(0xFF2E2A27),
    line = Color(0xFF312D2A),
    fg = Color(0xFFEDEBE7),
    fgMuted = Color(0xFFB5B0AB),
    fgSubtle = Color(0xFF96918C),
    accent = Color(0xFFB75439),
    accentText = Color(0xFFF2A588),
    accentSoft = Color(0xFF35201A),
    doneFg = Color(0xFF8ED8A8),
    doneBg = Color(0xFF132C20),
    attentionFg = Color(0xFFF5C66D),
    attentionBg = Color(0xFF3A270B),
    blockedFg = Color(0xFFF8A59B),
    blockedBg = Color(0xFF3E1F1B),
)

val LocalFirmaColors = staticCompositionLocalOf { Light }

@Composable
fun FirmaTheme(content: @Composable () -> Unit) {
    val colors = if (isSystemInDarkTheme()) Dark else Light
    val scheme = if (isSystemInDarkTheme()) {
        darkColorScheme(
            primary = colors.accent,
            onPrimary = Color.White,
            background = colors.surface,
            surface = colors.surface,
            surfaceVariant = colors.surface3,
            onBackground = colors.fg,
            onSurface = colors.fg,
            onSurfaceVariant = colors.fgMuted,
            outline = colors.line,
            error = colors.blockedFg,
        )
    } else {
        lightColorScheme(
            primary = colors.accent,
            onPrimary = Color.White,
            background = colors.surface,
            surface = colors.surface,
            surfaceVariant = colors.surface3,
            onBackground = colors.fg,
            onSurface = colors.fg,
            onSurfaceVariant = colors.fgMuted,
            outline = colors.line,
            error = colors.blockedFg,
        )
    }
    androidx.compose.runtime.CompositionLocalProvider(LocalFirmaColors provides colors) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}
