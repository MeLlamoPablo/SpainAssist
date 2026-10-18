package es.spainassist.firma.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * Line icons in the style of the designs (24 × 24, 2 dp strokes), for the few the Material core
 * set lacks. Tint them with `Icon(tint = …)`.
 */
internal object LineIcons {
    /** An official site, next to its host. */
    val Lock = icon(
        "lock",
        "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z",
        "M7 11V7a5 5 0 0 1 10 0v4",
    )

    /** A site the app doesn't recognise. */
    val Question = icon(
        "question",
        "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z",
        "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3",
        "M12 17h.01",
    )

    /** Opens the document in another app. */
    val OpenOutside = icon(
        "open-outside",
        "M15 3h6v6",
        "M10 14L21 3",
        "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
    )

    /** Something went wrong: a cross in a circle, so it differs from the warning by shape too. */
    val Blocked = icon(
        "blocked",
        "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z",
        "M15 9l-6 6",
        "M9 9l6 6",
    )

    private fun icon(name: String, vararg paths: String): ImageVector {
        val builder = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
        for (path in paths) {
            builder.addPath(
                addPathNodes(path),
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            )
        }
        return builder.build()
    }
}
