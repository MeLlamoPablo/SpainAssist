package es.spainassist.firma.ui

import kotlin.test.Test
import kotlin.test.assertEquals

class ReflowTest {
    @Test
    fun joinsWrappedLinesAndKeepsParagraphsAndListItems() {
        val licence = """
            Permission is hereby granted, free of charge,
              to any person obtaining a copy.

            The conditions:
            - keep this notice;
            - don't sue us.
            (a) You must give a copy
                of this License.
        """.trimIndent()
        assertEquals(
            "Permission is hereby granted, free of charge, to any person obtaining a copy.\n\n" +
                "The conditions:\n- keep this notice;\n- don't sue us.\n(a) You must give a copy of this License.",
            reflow(licence),
        )
    }
}
