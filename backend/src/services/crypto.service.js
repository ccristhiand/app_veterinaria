'use strict';

/**
 * VetClinic SaaS — Servicio de Encriptación AES-256-GCM
 * Para proteger credenciales SUNAT de cada tenant
 */

const crypto = require('crypto');

const ALGORITHM  = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH  = 16;
const TAG_LENGTH = 16;

// Clave maestra desde .env — nunca en BD
function getMasterKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY no configurada en .env');
  // Derivar clave de 32 bytes desde la variable de entorno
  return crypto.createHash('sha256').update(key).digest();
}

/**
 * Encripta un string con AES-256-GCM
 * Retorna: iv:tag:ciphertext en base64
 */
function encrypt(plaintext) {
  if (!plaintext) return null;
  try {
    const key = getMasterKey();
    const iv  = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(String(plaintext), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    // Formato: base64(iv):base64(tag):base64(ciphertext)
    return [
      iv.toString('base64'),
      tag.toString('base64'),
      encrypted.toString('base64'),
    ].join(':');
  } catch (err) {
    throw new Error(`Error al encriptar: ${err.message}`);
  }
}

/**
 * Desencripta un string encriptado con encrypt()
 */
function decrypt(ciphertext) {
  if (!ciphertext) return null;
  try {
    const key  = getMasterKey();
    const parts = ciphertext.split(':');
    if (parts.length !== 3) throw new Error('Formato inválido');
    const iv         = Buffer.from(parts[0], 'base64');
    const tag        = Buffer.from(parts[1], 'base64');
    const encrypted  = Buffer.from(parts[2], 'base64');
    const decipher   = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted  = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (err) {
    throw new Error(`Error al desencriptar: ${err.message}`);
  }
}

/**
 * Encripta un buffer (para certificados PFX)
 */
function encryptBuffer(buffer) {
  if (!buffer) return null;
  return encrypt(buffer.toString('base64'));
}

/**
 * Desencripta un buffer (para certificados PFX)
 */
function decryptBuffer(ciphertext) {
  if (!ciphertext) return null;
  const base64 = decrypt(ciphertext);
  return Buffer.from(base64, 'base64');
}

/**
 * Encripta solo si el valor no está ya encriptado
 */
function encryptIfNeeded(value) {
  if (!value) return null;
  // Si ya tiene el formato iv:tag:ciphertext, no encriptar de nuevo
  if (typeof value === 'string' && value.split(':').length === 3) return value;
  return encrypt(value);
}

module.exports = { encrypt, decrypt, encryptBuffer, decryptBuffer, encryptIfNeeded };