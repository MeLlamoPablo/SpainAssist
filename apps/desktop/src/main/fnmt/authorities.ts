/**
 * The FNMT CAs the app ships (`fnmt-ca/README.md`), from which a newly issued certificate's
 * path is built, as FNMT's Configurador does.
 */
import { X509Certificate } from 'node:crypto';
import {
  AC_FNMT_USUARIOS,
  AC_RAIZ_FNMT_RCM,
  AC_RAIZ_FNMT_RCM_G2,
  AC_REPRESENTACION,
  AC_REPRESENTACION_G2,
  AC_SECTOR_PUBLICO,
  AC_SECTOR_PUBLICO_G2,
  AC_USUARIOS_G2,
} from './fnmt-ca/certificates';

/** DER of FNMT's issuing CAs, then their roots (G1 and G2). */
export const FNMT_AUTHORITIES: readonly Uint8Array[] = [
  AC_FNMT_USUARIOS,
  AC_REPRESENTACION,
  AC_SECTOR_PUBLICO,
  AC_USUARIOS_G2,
  AC_REPRESENTACION_G2,
  AC_SECTOR_PUBLICO_G2,
  AC_RAIZ_FNMT_RCM,
  AC_RAIZ_FNMT_RCM_G2,
].map((pem) => new X509Certificate(pem).raw);
