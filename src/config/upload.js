const multer = require('multer');
const { fileTypeFromBuffer } = require('file-type');

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

// Premier filtre : basé sur le Content-Type déclaré (rapide, avant upload)
function fileFilter(req, file, cb) {
  if (ALLOWED_MIMES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Type de fichier non autorisé. Formats acceptés : JPEG, PNG, WebP, PDF'));
  }
}

// Store in memory — routes upload to Cloudinary and never touch disk.
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 8 * 1024 * 1024 },
});

// Middleware post-Multer : vérifie les magic bytes réels du fichier
// Bloque les fichiers exécutables renommés en .jpg/.png
async function verifyMagicBytes(req, res, next) {
  const files = req.files
    ? (Array.isArray(req.files) ? req.files : Object.values(req.files).flat())
    : (req.file ? [req.file] : []);

  for (const file of files) {
    const detected = await fileTypeFromBuffer(file.buffer);
    if (!detected || !ALLOWED_MIMES.includes(detected.mime)) {
      return res.status(400).json({
        error: `Fichier invalide (type détecté : ${detected?.mime || 'inconnu'}). Formats acceptés : JPEG, PNG, WebP, PDF`,
      });
    }
  }
  next();
}

module.exports = upload;
module.exports.verifyMagicBytes = verifyMagicBytes;
