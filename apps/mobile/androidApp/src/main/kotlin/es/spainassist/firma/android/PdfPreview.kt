package es.spainassist.firma.android

import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** The PDF's pages, rendered by Android's PdfRenderer (the bytes that will be signed). */
@Composable
fun PdfPreview(pdf: ByteArray) {
    val context = LocalContext.current
    var pages by remember(pdf) { mutableStateOf<List<Bitmap>?>(null) }
    var failed by remember(pdf) { mutableStateOf(false) }
    LaunchedEffect(pdf) {
        val rendered = withContext(Dispatchers.IO) {
            runCatching { render(File(context.cacheDir, "preview.pdf"), pdf) }.getOrNull()
        }
        if (rendered == null) failed = true else pages = rendered
    }
    val current = pages
    when {
        failed -> Text("PDF", color = Color.Gray)
        current == null -> Box(Modifier.fillMaxWidth().height(160.dp), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(current) { page ->
                Image(
                    bitmap = page.asImageBitmap(),
                    contentDescription = null,
                    contentScale = ContentScale.FillWidth,
                    modifier = Modifier.fillMaxWidth().background(Color.White),
                )
            }
        }
    }
}

private const val MAX_PAGES = 30
private const val WIDTH_PX = 1080

private fun render(file: File, pdf: ByteArray): List<Bitmap> {
    file.writeBytes(pdf)
    try {
        ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
            PdfRenderer(fd).use { renderer ->
                return (0 until minOf(renderer.pageCount, MAX_PAGES)).map { index ->
                    renderer.openPage(index).use { page ->
                        val height = (WIDTH_PX.toFloat() * page.height / page.width).toInt().coerceAtLeast(1)
                        val bitmap = Bitmap.createBitmap(WIDTH_PX, height, Bitmap.Config.ARGB_8888)
                        bitmap.eraseColor(android.graphics.Color.WHITE)
                        page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        bitmap
                    }
                }
            }
        }
    } finally {
        file.delete()
    }
}
