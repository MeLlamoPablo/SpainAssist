package es.spainassist.firma.android.nfc;

import es.gob.jmulticard.DigestAlgorithm;
import java.io.IOException;
import java.security.InvalidAlgorithmParameterException;
import java.security.InvalidKeyException;
import java.security.KeyPair;
import java.security.NoSuchAlgorithmException;
import java.security.SignatureException;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.security.interfaces.RSAKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.AlgorithmParameterSpec;
import es.gob.jmulticard.apdu.iso7816four.pace.PaceChat;
import es.gob.jmulticard.asn1.icao.CardAccess;
import es.gob.jmulticard.crypto.BcCryptoHelper;

/** Keeps PACE/CWA hashing intact; only DigestInfo's exact input bypasses hashing. */
final class LoginCryptoHelper extends es.gob.jmulticard.CryptoHelper {
    private final BcCryptoHelper delegate = new BcCryptoHelper();
    private byte[] prehashed;

    void setPrehashed(byte[] digest) {
        prehashed = digest;
    }

    @Override
    public byte[] digest(DigestAlgorithm algorithm, byte[] data) throws IOException {
        if (data == prehashed) return data.clone();
        return delegate.digest(algorithm, data);
    }

    @Override
    public byte[] desedeEncrypt(byte[] data, byte[] key) throws IOException {
        return delegate.desedeEncrypt(data, key);
    }

    @Override
    public byte[] desedeDecrypt(byte[] data, byte[] key) throws IOException {
        return delegate.desedeDecrypt(data, key);
    }

    @Override
    public byte[] desEncrypt(byte[] data, byte[] key) throws IOException {
        return delegate.desEncrypt(data, key);
    }

    @Override
    public byte[] desDecrypt(byte[] data, byte[] key) throws IOException {
        return delegate.desDecrypt(data, key);
    }

    @Override
    public byte[] aesDecrypt(byte[] data, byte[] iv, byte[] key, BlockMode blockMode, Padding padding) throws IOException {
        return delegate.aesDecrypt(data, iv, key, blockMode, padding);
    }

    @Override
    public byte[] aesEncrypt(byte[] data, byte[] iv, byte[] key, BlockMode blockMode, Padding padding) throws IOException {
        return delegate.aesEncrypt(data, iv, key, blockMode, padding);
    }

    @Override
    public byte[] rsaDecrypt(byte[] cipheredData, RSAKey key) throws IOException {
        return delegate.rsaDecrypt(cipheredData, key);
    }

    @Override
    public byte[] rsaEncrypt(byte[] data, RSAKey key) throws IOException {
        return delegate.rsaEncrypt(data, key);
    }

    @Override
    public byte[] generateRandomBytes(int numBytes) throws IOException {
        return delegate.generateRandomBytes(numBytes);
    }

    @Override
    public KeyPair generateEcKeyPair(EcCurve curveName) throws NoSuchAlgorithmException, InvalidAlgorithmParameterException {
        return delegate.generateEcKeyPair(curveName);
    }

    @Override
    public byte[] doAesCmac(byte[] data, byte[] key) throws NoSuchAlgorithmException, InvalidKeyException {
        return delegate.doAesCmac(data, key);
    }

    @Override
    public AlgorithmParameterSpec getEcPoint(byte[] nonceS, byte[] sharedSecretH, EcCurve curveName) {
        return delegate.getEcPoint(nonceS, sharedSecretH, curveName);
    }

    @Override
    public byte[] getCmsSignatureSignedContent(byte[] signedDataBytes) throws IOException {
        return delegate.getCmsSignatureSignedContent(signedDataBytes);
    }

    @Override
    public X509Certificate[] validateCmsSignature(byte[] signedDataBytes) throws SignatureException, IOException, CertificateException {
        return delegate.validateCmsSignature(signedDataBytes);
    }

    @Override
    public RSAPublicKey getRsaPublicKey(final X509Certificate cert) {
        return delegate.getRsaPublicKey(cert);
    }

    @Override
    public PaceChannelHelper getPaceChannelHelper(final CardAccess cardAccess, final PaceChat paceChat) {
        return delegate.getPaceChannelHelper(cardAccess, paceChat);
    }
}
