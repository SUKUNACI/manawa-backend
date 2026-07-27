const PDFDocument = require('pdfkit');
const { uploadBuffer } = require('../config/cloudinary');

const ORANGE = '#F4720B';
const DARK = '#1A1A2E';
const MUTED = '#6B7280';
const BORDER = '#E5E7EB';

function formatNumber(n) {
  return n.toLocaleString('fr-FR');
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Génère le buffer PDF en mémoire sans uploader
function generateQuotePdfBuffer(quote, professional, project) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    buildPdfContent(doc, quote, professional, project);
    doc.end();
  });
}

// Génère le PDF et l'uploade sur Cloudinary, retourne l'URL
function generateQuotePdf(quote, professional, project) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks);
        const fileName = `devis-${quote.id.substring(0, 8)}-v${quote.version}`;
        const url = await uploadBuffer(buffer, 'manawa/quotes', {
          resource_type: 'raw',
          type: 'upload',
          access_mode: 'public',
          public_id: fileName,
          format: 'pdf',
          overwrite: true,
          invalidate: true,
        });
        resolve(url);
      } catch (err) {
        reject(err);
      }
    });

    buildPdfContent(doc, quote, professional, project);
  });
}

function buildPdfContent(doc, quote, professional, project) {
    const pageWidth = doc.page.width - 100;

    // === EN-TÊTE ===
    doc.rect(0, 0, doc.page.width, 120).fill('#F8F9FA');

    doc.fontSize(22).fillColor(ORANGE).font('Helvetica-Bold')
      .text('DEVIS', 50, 40);

    doc.fontSize(9).fillColor(MUTED).font('Helvetica')
      .text(`N° ${quote.id.substring(0, 8).toUpperCase()}`, 50, 68)
      .text(`Version ${quote.version}`, 50, 82)
      .text(`Date : ${formatDate(quote.createdAt)}`, 50, 96);

    if (quote.expiresAt) {
      doc.fontSize(9).fillColor(DARK)
        .text(`Valable jusqu'au : ${formatDate(quote.expiresAt)}`, 300, 96, { align: 'right', width: pageWidth - 250 });
    }

    // === PROFESSIONNEL ===
    let y = 140;
    doc.fontSize(10).fillColor(ORANGE).font('Helvetica-Bold').text('ÉMETTEUR', 50, y);
    y += 16;

    const proUser = professional.user || {};
    doc.fontSize(10).fillColor(DARK).font('Helvetica-Bold')
      .text(`${proUser.firstName || ''} ${proUser.lastName || ''}`, 50, y);
    y += 14;
    doc.fontSize(9).fillColor(MUTED).font('Helvetica');
    if (professional.trade) { doc.text(professional.trade, 50, y); y += 12; }
    if (proUser.email) { doc.text(proUser.email, 50, y); y += 12; }
    if (proUser.phone) { doc.text(proUser.phone, 50, y); y += 12; }
    if (proUser.city) { doc.text(proUser.city, 50, y); y += 12; }

    // === CLIENT ===
    let yClient = 140;
    doc.fontSize(10).fillColor(ORANGE).font('Helvetica-Bold').text('CLIENT', 350, yClient);
    yClient += 16;

    const client = project.client || {};
    doc.fontSize(10).fillColor(DARK).font('Helvetica-Bold')
      .text(`${client.firstName || ''} ${client.lastName || ''}`, 350, yClient);
    yClient += 14;
    doc.fontSize(9).fillColor(MUTED).font('Helvetica');
    if (client.email) { doc.text(client.email, 350, yClient); yClient += 12; }
    if (client.phone) { doc.text(client.phone, 350, yClient); yClient += 12; }
    if (client.city) { doc.text(client.city, 350, yClient); yClient += 12; }

    // === PROJET ===
    y = Math.max(y, yClient) + 20;
    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor(BORDER).stroke();
    y += 15;

    doc.fontSize(10).fillColor(ORANGE).font('Helvetica-Bold').text('PROJET', 50, y);
    y += 16;
    doc.fontSize(10).fillColor(DARK).font('Helvetica-Bold').text(project.title, 50, y);
    y += 14;
    doc.fontSize(9).fillColor(MUTED).font('Helvetica')
      .text(`${project.tradeNeeded || ''} · ${project.city || ''}`, 50, y);
    y += 20;

    // === CONTENU ===
    doc.moveTo(50, y).lineTo(50 + pageWidth, y).strokeColor(BORDER).stroke();
    y += 15;

    if (quote.mode === 'DETAILED' && quote.items && quote.items.length > 0) {
      const colWidths = { label: 200, qty: 50, unit: 50, unitPrice: 90, total: 100 };

      doc.rect(50, y, pageWidth, 22).fill('#F3F4F6');
      doc.fontSize(8).fillColor(MUTED).font('Helvetica-Bold');
      doc.text('DÉSIGNATION', 55, y + 7, { width: colWidths.label });
      doc.text('QTÉ', 55 + colWidths.label, y + 7, { width: colWidths.qty, align: 'center' });
      doc.text('UNITÉ', 55 + colWidths.label + colWidths.qty, y + 7, { width: colWidths.unit, align: 'center' });
      doc.text('PRIX UNIT.', 55 + colWidths.label + colWidths.qty + colWidths.unit, y + 7, { width: colWidths.unitPrice, align: 'right' });
      doc.text('TOTAL', 55 + colWidths.label + colWidths.qty + colWidths.unit + colWidths.unitPrice, y + 7, { width: colWidths.total, align: 'right' });
      y += 26;

      const categories = {
        LABOUR: { label: "Main d'œuvre", items: [] },
        MATERIALS: { label: 'Matériaux', items: [] },
        OTHER: { label: 'Autres', items: [] },
      };

      quote.items.forEach(item => {
        const cat = categories[item.category] || categories.OTHER;
        cat.items.push(item);
      });

      Object.entries(categories).forEach(([, cat]) => {
        if (cat.items.length === 0) return;

        doc.rect(50, y, pageWidth, 18).fill('#FAFAFA');
        doc.fontSize(8).fillColor(ORANGE).font('Helvetica-Bold')
          .text(cat.label.toUpperCase(), 55, y + 5);
        y += 22;

        cat.items.forEach(item => {
          if (y > 720) { doc.addPage(); y = 50; }

          doc.fontSize(9).fillColor(DARK).font('Helvetica');
          doc.text(item.label, 55, y, { width: colWidths.label });
          doc.text(String(item.quantity), 55 + colWidths.label, y, { width: colWidths.qty, align: 'center' });
          doc.text(item.unit || '-', 55 + colWidths.label + colWidths.qty, y, { width: colWidths.unit, align: 'center' });
          doc.text(`${formatNumber(item.unitPrice)} FCFA`, 55 + colWidths.label + colWidths.qty + colWidths.unit, y, { width: colWidths.unitPrice, align: 'right' });
          doc.font('Helvetica-Bold')
            .text(`${formatNumber(item.total || item.quantity * item.unitPrice)} FCFA`, 55 + colWidths.label + colWidths.qty + colWidths.unit + colWidths.unitPrice, y, { width: colWidths.total, align: 'right' });
          y += 18;

          doc.moveTo(50, y - 2).lineTo(50 + pageWidth, y - 2).strokeColor('#F3F4F6').lineWidth(0.5).stroke();
        });

        const catTotal = cat.items.reduce((s, i) => s + (i.total || i.quantity * i.unitPrice), 0);
        doc.fontSize(8).fillColor(MUTED).font('Helvetica')
          .text(`Sous-total ${cat.label}`, 55, y + 2, { width: colWidths.label + colWidths.qty + colWidths.unit + colWidths.unitPrice });
        doc.fontSize(9).fillColor(DARK).font('Helvetica-Bold')
          .text(`${formatNumber(catTotal)} FCFA`, 55 + colWidths.label + colWidths.qty + colWidths.unit + colWidths.unitPrice, y + 2, { width: colWidths.total, align: 'right' });
        y += 22;
      });

      y += 5;
      doc.rect(50, y, pageWidth, 30).fill(ORANGE);
      doc.fontSize(12).fillColor('#FFFFFF').font('Helvetica-Bold')
        .text('TOTAL', 60, y + 9)
        .text(`${formatNumber(quote.amount)} FCFA`, 60, y + 9, { width: pageWidth - 20, align: 'right' });
      y += 40;

    } else {
      doc.fontSize(10).fillColor(DARK).font('Helvetica-Bold').text('Montant proposé', 50, y);
      y += 20;

      doc.rect(50, y, pageWidth, 36).fill(ORANGE);
      doc.fontSize(16).fillColor('#FFFFFF').font('Helvetica-Bold')
        .text(`${formatNumber(quote.amount)} FCFA`, 60, y + 10, { width: pageWidth - 20, align: 'center' });
      y += 50;
    }

    // === DESCRIPTION ===
    if (quote.description) {
      if (y > 680) { doc.addPage(); y = 50; }
      y += 10;
      doc.fontSize(10).fillColor(ORANGE).font('Helvetica-Bold').text('DESCRIPTION & CONDITIONS', 50, y);
      y += 16;
      doc.fontSize(9).fillColor(DARK).font('Helvetica')
        .text(quote.description, 50, y, { width: pageWidth, lineGap: 4 });
      y += doc.heightOfString(quote.description, { width: pageWidth, lineGap: 4 }) + 20;
    }

    // === PIED DE PAGE ===
    const footerY = doc.page.height - 80;
    doc.moveTo(50, footerY).lineTo(50 + pageWidth, footerY).strokeColor(BORDER).lineWidth(0.5).stroke();

    doc.fontSize(8).fillColor(MUTED).font('Helvetica')
      .text(`Devis généré via MANAWA · Validité : ${quote.validityDays || 15} jours à compter de la date d'émission`, 50, footerY + 10, { width: pageWidth, align: 'center' })
      .text('Ce document ne constitue pas une facture. Les prix sont exprimés en FCFA.', 50, footerY + 22, { width: pageWidth, align: 'center' });
}

module.exports = generateQuotePdf;
module.exports.generateQuotePdfBuffer = generateQuotePdfBuffer;
