package es.spainassist.firma.android.nfc;

import es.gob.jmulticard.DigestAlgorithm;
import es.gob.jmulticard.asn1.der.pkcs1.DigestInfo;
import java.security.MessageDigest;
import java.util.Arrays;
import org.junit.Test;
import static org.junit.Assert.assertArrayEquals;

public class LoginCryptoHelperTest {
    @Test public void digestInfoUsesTheTlsDigestAndKeepsChannelHashing() throws Exception {
        LoginCryptoHelper helper = new LoginCryptoHelper();
        for (String algorithm : new String[] { "SHA1", "SHA256", "SHA384", "SHA512" }) {
            byte[] digest = MessageDigest.getInstance(algorithm).digest(new byte[] { 1, 2, 3 });
            helper.setPrehashed(digest);
            byte[] encoded = DigestInfo.encode(algorithm + "withRSA", digest, helper);
            assertArrayEquals(digest, Arrays.copyOfRange(encoded, encoded.length - digest.length, encoded.length));
            // Secure-channel hashes still use the ordinary helper, even for identical bytes.
            assertArrayEquals(MessageDigest.getInstance("SHA-256").digest(digest), helper.digest(DigestAlgorithm.SHA256, digest.clone()));
            helper.setPrehashed(null);
            assertArrayEquals(MessageDigest.getInstance("SHA-256").digest(digest), helper.digest(DigestAlgorithm.SHA256, digest));
        }
    }
}
