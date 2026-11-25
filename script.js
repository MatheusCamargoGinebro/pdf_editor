/**
 * ============================================================================
 * PDF Studio Pro — Motor Completo de Edição de PDF no Navegador
 * ============================================================================
 * Arquitetura Modular (ES6+, compatível com file:// e servidores HTTP):
 *  1. Utils & Helpers (Cores, Fontes, Coordenadas, WinAnsi, Toast)
 *  2. HistoryManager (Desfazer / Refazer com snapshots de estado)
 *  3. PDFEngine (Carregamento PDF.js, Renderização HiDPI, Extração Inteligente
 *                de Texto preservando colunas/tabelas, Amostragem de Cores)
 *  4. SamplePDFGenerator (PDF de demonstração e PDF em branco via pdf-lib)
 *  5. SignatureManager (Assinatura desenhada, digitada ou imagem)
 *  6. OCRManager (Tesseract.js sob demanda para PDFs escaneados)
 *  7. PDFExporter (Exportação nos 3 modos: Original, Editável e Final)
 *  8. PDFEditorApp (Controlador principal, camadas, eventos, atalhos e UI)
 * ============================================================================
 */

(() => {
  'use strict';

  /* ==========================================================================
     1. CONSTANTES E UTILITÁRIOS
     ========================================================================== */
  const PROJECT_ATTACHMENT_NAME = 'pdf-studio-pro-project.json';

  const TOOL_META = {
    select:     { label: 'Selecionar',    hint: 'Arraste para mover, use as alças para redimensionar/rotacionar ou clique duplo no texto.' },
    'edit-text':{ label: 'Editar Texto',  hint: 'Clique diretamente sobre qualquer texto original do PDF para editar inline sem quebrar o layout.' },
    textbox:    { label: 'Caixa de Texto',hint: 'Clique ou arraste na página para inserir uma nova caixa de texto formatável.' },
    highlight:  { label: 'Destacar',      hint: 'Arraste sobre qualquer região de texto para aplicar marca-texto translúcido.' },
    comment:    { label: 'Comentário',    hint: 'Clique na página para fixar um comentário/nota adesiva.' },
    draw:       { label: 'Desenho Livre', hint: 'Clique e arraste para desenhar à mão livre com curvas suaves.' },
    shape:      { label: 'Forma',         hint: 'Arraste na página para desenhar a forma geométrica selecionada.' },
    image:      { label: 'Imagem',        hint: 'Selecione uma imagem para inserir, mover, redimensionar ou rotacionar.' },
    signature:  { label: 'Assinatura',    hint: 'Crie ou selecione sua assinatura digital para posicionar no documento.' },
    form:       { label: 'Formulário',    hint: 'Clique ou arraste na página para criar um campo de formulário interativo (AcroForm).' }
  };

  const Utils = {
    uid(prefix = 'el') {
      return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    },

    clamp(val, min, max) {
      return Math.min(Math.max(val, min), max);
    },

    round1(n) {
      return Math.round(n * 10) / 10;
    },

    hexToRgb01(hex) {
      const clean = (hex || '#000000').replace('#', '').trim();
      const full = clean.length === 3
        ? clean.split('').map(c => c + c).join('')
        : clean.padEnd(6, '0').slice(0, 6);
      const num = parseInt(full, 16);
      return {
        r: ((num >> 16) & 255) / 255,
        g: ((num >> 8) & 255) / 255,
        b: (num & 255) / 255
      };
    },

    rgbToHex(r, g, b) {
      const toHex = (v) => Utils.clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
      return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    },

    colorDistance(c1, c2) {
      return Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]);
    },

    /**
     * Mapeia o nome interno da fonte do PDF (ex.: BCDEEE+Arial-BoldItalicMT)
     * para família CSS, peso e estilo o mais fiel possível.
     */
    parsePdfFont(rawFontName = '', styleInfo = {}) {
      const name = `${rawFontName} ${styleInfo.fontFamily || ''}`.toLowerCase();
      const bold = /bold|black|heavy|demi|semibold|medi|700|800/.test(name);
      const italic = /italic|oblique|slant/.test(name);

      let fontFamily = 'Helvetica, Arial, sans-serif';
      if (/courier|mono|consolas|menlo|fixed/.test(name)) {
        fontFamily = "'Courier New', Courier, monospace";
      } else if (/times|georgia|garamond|palatino|cambria|serif/.test(name) && !/sans/.test(name)) {
        fontFamily = "'Times New Roman', Times, serif";
      } else if (/verdana/.test(name)) {
        fontFamily = 'Verdana, Geneva, sans-serif';
      } else if (/trebuchet/.test(name)) {
        fontFamily = "'Trebuchet MS', sans-serif";
      }

      return { fontFamily, bold, italic };
    },

    /**
     * Mapeia família CSS + negrito + itálico para uma StandardFont do pdf-lib.
     */
    getStandardFontKey(fontFamily = '', bold = false, italic = false) {
      const f = fontFamily.toLowerCase();
      const SF = PDFLib.StandardFonts;
      if (f.includes('courier') || f.includes('mono')) {
        if (bold && italic) return SF.CourierBoldOblique;
        if (bold) return SF.CourierBold;
        if (italic) return SF.CourierOblique;
        return SF.Courier;
      }
      if (f.includes('times') || f.includes('georgia') || f.includes('serif')) {
        if (!f.includes('sans')) {
          if (bold && italic) return SF.TimesRomanBoldItalic;
          if (bold) return SF.TimesRomanBold;
          if (italic) return SF.TimesRomanItalic;
          return SF.TimesRoman;
        }
      }
      if (bold && italic) return SF.HelveticaBoldOblique;
      if (bold) return SF.HelveticaBold;
      if (italic) return SF.HelveticaOblique;
      return SF.Helvetica;
    },

    /**
     * Verifica se todos os caracteres do texto são codificáveis em WinAnsi (pdf-lib StandardFonts).
     */
    isWinAnsiSafe(text = '') {
      // WinAnsi suporta ASCII + Latin-1 (0xA0–0xFF) + alguns símbolos (euro, travessões, aspas curvas)
      const extras = new Set([0x20AC, 0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x2122]);
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 10 || code === 13 || code === 9) continue;
        if (code >= 0x20 && code <= 0x7E) continue;
        if (code >= 0xA0 && code <= 0xFF) continue;
        if (extras.has(code)) continue;
        return false;
      }
      return true;
    },

    /**
     * Converte imagem em qualquer formato (WebP, GIF, SVG, etc.) para PNG Uint8Array.
     */
    async dataUrlToPngBytes(dataUrl) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth || img.width || 300;
          canvas.height = img.naturalHeight || img.height || 150;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(async (blob) => {
            if (!blob) return reject(new Error('Falha ao converter imagem para PNG.'));
            const ab = await blob.arrayBuffer();
            resolve(new Uint8Array(ab));
          }, 'image/png');
        };
        img.onerror = () => reject(new Error('Não foi possível decodificar a imagem.'));
        img.src = dataUrl;
      });
    },

    /**
     * Quebra texto em linhas respeitando largura máxima em um contexto Canvas ou fonte pdf-lib.
     */
    wrapTextLines(text, maxWidth, measureFn) {
      const paragraphs = String(text || '').replace(/\r/g, '').split('\n');
      const lines = [];
      for (const para of paragraphs) {
        if (!para) {
          lines.push('');
          continue;
        }
        const words = para.split(/(\s+)/);
        let current = '';
        for (const token of words) {
          const test = current + token;
          if (current && measureFn(test) > maxWidth && token.trim() !== '') {
            lines.push(current.trimEnd());
            current = token.trimStart();
          } else {
            current = test;
          }
        }
        if (current) lines.push(current);
      }
      return lines.length ? lines : [''];
    },

    toast(message, type = 'info', duration = 3200) {
      const container = document.getElementById('toastContainer');
      if (!container) return;
      const el = document.createElement('div');
      el.className = `toast ${type}`;
      el.textContent = message;
      container.appendChild(el);
      setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(8px)';
        el.style.transition = 'opacity 0.2s, transform 0.2s';
        setTimeout(() => el.remove(), 220);
      }, duration);
    },

    deepClone(obj) {
      return JSON.parse(JSON.stringify(obj));
    },

    formatTimestamp(date = new Date()) {
      return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
  };

  /* ==========================================================================
     2. HISTORY MANAGER (UNDO / REDO COMPLETO)
     ========================================================================== */
  class HistoryManager {
    constructor(maxSteps = 60) {
      this.maxSteps = maxSteps;
      this.undoStack = [];
      this.redoStack = [];
    }

    clear() {
      this.undoStack = [];
      this.redoStack = [];
    }

    push(snapshot) {
      const serialized = JSON.stringify(snapshot);
      if (this.undoStack.length && this.undoStack[this.undoStack.length - 1] === serialized) {
        return;
      }
      this.undoStack.push(serialized);
      if (this.undoStack.length > this.maxSteps) {
        this.undoStack.shift();
      }
      this.redoStack = [];
    }

    canUndo() { return this.undoStack.length > 1; }
    canRedo() { return this.redoStack.length > 0; }

    undo() {
      if (!this.canUndo()) return null;
      const current = this.undoStack.pop();
      this.redoStack.push(current);
      return JSON.parse(this.undoStack[this.undoStack.length - 1]);
    }

    redo() {
      if (!this.canRedo()) return null;
      const next = this.redoStack.pop();
      this.undoStack.push(next);
      return JSON.parse(next);
    }
  }

  /* ==========================================================================
     3. PDF ENGINE (PDF.js RENDERING, EXTRACTION & PIXEL COLOR SAMPLING)
     ========================================================================== */
  class PDFEngine {
    constructor() {
      // Configura PDF.js de forma segura tanto para file:// quanto http(s)://
      if (window.pdfjsLib) {
        if (!window.pdfjsWorker && window.location.protocol !== 'file:') {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        }
      }
      this.pdfDoc = null;
      this.originalBytes = null;
      this.pageCanvases = new Map(); // pageIndex -> { canvas, scale }
    }

    async loadFromBytes(uint8Array) {
      this.originalBytes = new Uint8Array(uint8Array);
      this.pageCanvases.clear();
      const loadingTask = window.pdfjsLib.getDocument({
        data: this.originalBytes.slice(), // passa cópia para preservar originalBytes intacto
        cMapPacked: true
      });
      this.pdfDoc = await loadingTask.promise;

      // Verifica se existe projeto editável embutido anteriormente por este editor
      let embeddedProject = null;
      try {
        const attachments = await this.pdfDoc.getAttachments();
        if (attachments && attachments[PROJECT_ATTACHMENT_NAME]) {
          const bytes = attachments[PROJECT_ATTACHMENT_NAME].content;
          const decoded = new TextDecoder('utf-8').decode(bytes);
          embeddedProject = JSON.parse(decoded);
        }
      } catch (err) {
        console.warn('Sem projeto embutido restaurável:', err);
      }

      return {
        numPages: this.pdfDoc.numPages,
        embeddedProject
      };
    }

    async getPageMeta(pageIndex) {
      const page = await this.pdfDoc.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1 });
      return {
        page,
        width: viewport.width,
        height: viewport.height,
        rotation: page.rotate || 0
      };
    }

    /**
     * Renderiza uma página em alta definição (respeitando devicePixelRatio).
     */
    async renderPageToCanvas(pageIndex, canvas, zoomScale) {
      const page = await this.pdfDoc.getPage(pageIndex + 1);
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const cssViewport = page.getViewport({ scale: zoomScale });
      const renderViewport = page.getViewport({ scale: zoomScale * dpr });

      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      canvas.style.width = `${cssViewport.width}px`;
      canvas.style.height = `${cssViewport.height}px`;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
      this.pageCanvases.set(pageIndex, { canvas, scale: zoomScale * dpr });
      return cssViewport;
    }

    /**
     * Renderiza miniatura otimizada para a barra lateral esquerda.
     */
    async renderThumbnail(pageIndex, canvas, targetWidth = 148) {
      const page = await this.pdfDoc.getPage(pageIndex + 1);
      const baseVp = page.getViewport({ scale: 1 });
      const scale = targetWidth / baseVp.width;
      const vp = page.getViewport({ scale });
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    }

    /**
     * Extrai os blocos de texto do PDF com coordenadas exatas (em pontos PDF),
     * agrupando apenas palavras contíguas na mesma linha e estilo — preservando
     * rigorosamente colunas de tabelas e alinhamentos independentes.
     */
    async extractTextRuns(pageIndex) {
      const page = await this.pdfDoc.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const styles = textContent.styles || {};

      const rawItems = [];
      for (const item of textContent.items) {
        if (!item.str || !item.str.trim()) continue;

        const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
        const fontHeight = Math.hypot(tx[2], tx[3]) || Math.abs(item.height) || 12;
        const angleRad = Math.atan2(tx[1], tx[0]);
        const angleDeg = Math.round((angleRad * 180) / Math.PI);

        // Coordenadas em pontos PDF (origem topo-esquerda)
        const x = tx[4];
        const baselineY = tx[5];
        const y = baselineY - fontHeight * 0.88;
        const height = fontHeight * 1.18;
        const width = Math.max(item.width || (item.str.length * fontHeight * 0.52), 4);

        const fontStyle = Utils.parsePdfFont(item.fontName, styles[item.fontName]);

        rawItems.push({
          str: item.str,
          x,
          y,
          baselineY,
          width,
          height,
          fontSize: Utils.round1(fontHeight),
          rotation: Math.abs(angleDeg) < 2 ? 0 : angleDeg,
          fontFamily: fontStyle.fontFamily,
          bold: fontStyle.bold,
          italic: fontStyle.italic
        });
      }

      // Agrupamento conservador: une apenas trechos adjacentes na mesma linha,
      // mesma rotação e mesma tipografia, sem nunca unir colunas de tabelas.
      const merged = [];
      for (const cur of rawItems) {
        const prev = merged[merged.length - 1];
        const sameLine = prev &&
          Math.abs(cur.baselineY - prev.baselineY) <= Math.max(2.2, cur.fontSize * 0.25) &&
          Math.abs(cur.fontSize - prev.fontSize) <= 0.9 &&
          cur.fontFamily === prev.fontFamily &&
          cur.bold === prev.bold &&
          cur.italic === prev.italic &&
          cur.rotation === prev.rotation;

        const prevRight = prev ? (prev.x + prev.width) : 0;
        const gap = cur.x - prevRight;
        const isAdjacent = sameLine && gap >= -(cur.fontSize * 0.35) && gap <= (cur.fontSize * 0.72);

        if (isAdjacent) {
          const needsSpace = gap > cur.fontSize * 0.16 && !prev.str.endsWith(' ') && !cur.str.startsWith(' ');
          prev.str += (needsSpace ? ' ' : '') + cur.str;
          const newRight = Math.max(prevRight, cur.x + cur.width);
          prev.width = newRight - prev.x;
          prev.height = Math.max(prev.height, cur.height);
        } else {
          merged.push({ ...cur });
        }
      }

      return merged.map((m, idx) => ({
        id: `tr_${pageIndex}_${idx}_${Math.random().toString(36).slice(2, 6)}`,
        pageIndex,
        // Geometria original imutável (usada pela máscara de preservação)
        origX: Utils.round1(m.x),
        origY: Utils.round1(m.y),
        origW: Utils.round1(m.width),
        origH: Utils.round1(m.height),
        origText: m.str,
        origFontFamily: m.fontFamily,
        origFontSize: m.fontSize,
        origBold: m.bold,
        origItalic: m.italic,
        // Estado editável atual
        x: Utils.round1(m.x),
        y: Utils.round1(m.y),
        width: Utils.round1(m.width),
        height: Utils.round1(m.height),
        rotation: m.rotation,
        opacity: 1,
        text: m.str,
        fontFamily: m.fontFamily,
        fontSize: m.fontSize,
        color: '#111111',
        maskColor: '#ffffff',
        colorSampled: false,
        bold: m.bold,
        italic: m.italic,
        underline: false,
        strikethrough: false,
        align: 'left',
        lineHeight: 1.15,
        edited: false,
        moved: false,
        deleted: false,
        fromOcr: false
      }));
    }

    /**
     * Amostra diretamente do canvas renderizado a cor exata de fundo (máscara)
     * e a cor predominante da tinta do texto original.
     */
    sampleRunColors(pageIndex, x, y, width, height) {
      const entry = this.pageCanvases.get(pageIndex);
      if (!entry) return { bgHex: '#ffffff', fgHex: '#111111' };

      const { canvas, scale } = entry;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const px = Math.max(0, Math.floor(x * scale));
      const py = Math.max(0, Math.floor(y * scale));
      const pw = Math.min(canvas.width - px, Math.max(4, Math.ceil(width * scale)));
      const ph = Math.min(canvas.height - py, Math.max(4, Math.ceil(height * scale)));
      if (pw <= 0 || ph <= 0) return { bgHex: '#ffffff', fgHex: '#111111' };

      try {
        // Amostra margem de 2px ao redor para detectar fundo de célula/banner
        const bx = Math.max(0, px - 2);
        const by = Math.max(0, py - 2);
        const bw = Math.min(canvas.width - bx, pw + 4);
        const bh = Math.min(canvas.height - by, ph + 4);
        const imgData = ctx.getImageData(bx, by, bw, bh).data;

        const getPixel = (lx, ly) => {
          const idx = (ly * bw + lx) * 4;
          return [imgData[idx], imgData[idx + 1], imgData[idx + 2]];
        };

        // 1. Cor de fundo: moda quantizada dos pixels de borda
        const borderBuckets = new Map();
        const addBorder = (lx, ly) => {
          const [r, g, b] = getPixel(lx, ly);
          const key = `${r >> 3},${g >> 3},${b >> 3}`;
          const cur = borderBuckets.get(key) || { count: 0, r: 0, g: 0, b: 0 };
          cur.count++;
          cur.r += r; cur.g += g; cur.b += b;
          borderBuckets.set(key, cur);
        };

        for (let lx = 0; lx < bw; lx += Math.max(1, Math.floor(bw / 16))) {
          addBorder(lx, 0);
          addBorder(lx, bh - 1);
        }
        for (let ly = 0; ly < bh; ly += Math.max(1, Math.floor(bh / 8))) {
          addBorder(0, ly);
          addBorder(bw - 1, ly);
        }

        let bestBg = { count: 0, r: 255, g: 255, b: 255 };
        for (const b of borderBuckets.values()) {
          if (b.count > bestBg.count) bestBg = b;
        }
        const bgRgb = bestBg.count
          ? [bestBg.r / bestBg.count, bestBg.g / bestBg.count, bestBg.b / bestBg.count]
          : [255, 255, 255];

        // 2. Cor do texto: média dos pixels internos com maior contraste contra o fundo
        let fgCandidates = [];
        const stepX = Math.max(1, Math.floor(bw / 45));
        const stepY = Math.max(1, Math.floor(bh / 16));
        for (let ly = 1; ly < bh - 1; ly += stepY) {
          for (let lx = 1; lx < bw - 1; lx += stepX) {
            const p = getPixel(lx, ly);
            const dist = Utils.colorDistance(p, bgRgb);
            if (dist > 38) {
              fgCandidates.push({ p, dist });
            }
          }
        }

        let fgRgb = [17, 17, 17];
        if (fgCandidates.length) {
          fgCandidates.sort((a, b) => b.dist - a.dist);
          const topCount = Math.max(1, Math.ceil(fgCandidates.length * 0.25));
          let sr = 0, sg = 0, sb = 0;
          for (let i = 0; i < topCount; i++) {
            sr += fgCandidates[i].p[0];
            sg += fgCandidates[i].p[1];
            sb += fgCandidates[i].p[2];
          }
          fgRgb = [sr / topCount, sg / topCount, sb / topCount];
        } else {
          // Se fundo for escuro, sugere texto branco
          const lum = 0.299 * bgRgb[0] + 0.587 * bgRgb[1] + 0.114 * bgRgb[2];
          fgRgb = lum < 128 ? [255, 255, 255] : [17, 17, 17];
        }

        return {
          bgHex: Utils.rgbToHex(bgRgb[0], bgRgb[1], bgRgb[2]),
          fgHex: Utils.rgbToHex(fgRgb[0], fgRgb[1], fgRgb[2])
        };
      } catch {
        return { bgHex: '#ffffff', fgHex: '#111111' };
      }
    }
  }

  /* ==========================================================================
     4. GERADOR DE PDF DE DEMONSTRAÇÃO E EM BRANCO (pdf-lib)
     ========================================================================== */
  const SamplePDFGenerator = {
    async createDemoPdf() {
      const { PDFDocument, StandardFonts, rgb } = PDFLib;
      const doc = await PDFDocument.create();
      const fontReg = await doc.embedFont(StandardFonts.Helvetica);
      const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
      const fontItalic = await doc.embedFont(StandardFonts.HelveticaOblique);
      const fontSerif = await doc.embedFont(StandardFonts.TimesRoman);

      // ---------- PÁGINA 1: Relatório Corporativo com Banner, Colunas e Tabela ----------
      const p1 = doc.addPage([595.28, 841.89]); // A4
      const { width, height } = p1.getSize();

      // Banner superior azul-marinho
      p1.drawRectangle({ x: 0, y: height - 108, width, height: 108, color: rgb(0.09, 0.19, 0.36) });
      p1.drawText('RELATÓRIO EXECUTIVO & PROPOSTA COMERCIAL', {
        x: 42, y: height - 52, size: 18, font: fontBold, color: rgb(1, 1, 1)
      });
      p1.drawText('Documento de Demonstração — Teste a edição inline sem quebrar o layout', {
        x: 42, y: height - 76, size: 10.5, font: fontItalic, color: rgb(0.76, 0.85, 0.98)
      });
      p1.drawText('Ref.: #2026-0481', {
        x: width - 140, y: height - 50, size: 10, font: fontBold, color: rgb(0.95, 0.78, 0.25)
      });

      // Bloco de metadados em 2 colunas
      p1.drawRectangle({ x: 42, y: height - 205, width: width - 84, height: 76, color: rgb(0.96, 0.97, 0.99), borderColor: rgb(0.84, 0.88, 0.94), borderWidth: 1 });
      p1.drawText('CLIENTE:', { x: 56, y: height - 150, size: 9, font: fontBold, color: rgb(0.35, 0.42, 0.52) });
      p1.drawText('Horizonte Engenharia & Sistemas Ltda.', { x: 56, y: height - 166, size: 11.5, font: fontBold, color: rgb(0.1, 0.14, 0.22) });
      p1.drawText('Av. Paulista, 1578 — São Paulo, SP', { x: 56, y: height - 184, size: 9.5, font: fontReg, color: rgb(0.3, 0.36, 0.45) });

      p1.drawText('DATA DE EMISSÃO:', { x: 350, y: height - 150, size: 9, font: fontBold, color: rgb(0.35, 0.42, 0.52) });
      p1.drawText('25 de Novembro de 2026', { x: 350, y: height - 166, size: 11, font: fontReg, color: rgb(0.1, 0.14, 0.22) });
      p1.drawText('Validade: 30 dias corridos', { x: 350, y: height - 184, size: 9.5, font: fontReg, color: rgb(0.3, 0.36, 0.45) });

      // Parágrafo introdutório
      p1.drawText('1. Resumo do Escopo', { x: 42, y: height - 242, size: 13.5, font: fontBold, color: rgb(0.09, 0.19, 0.36) });
      p1.drawText('Este documento apresenta o detalhamento financeiro e técnico dos serviços contratados.', {
        x: 42, y: height - 264, size: 10.5, font: fontSerif, color: rgb(0.15, 0.18, 0.22)
      });
      p1.drawText('Clique em qualquer linha, célula da tabela ou cabeçalho colorido para editar mantendo o alinhamento.', {
        x: 42, y: height - 280, size: 10.5, font: fontSerif, color: rgb(0.15, 0.18, 0.22)
      });

      // Tabela Financeira Estruturada
      p1.drawText('2. Detalhamento Financeiro', { x: 42, y: height - 320, size: 13.5, font: fontBold, color: rgb(0.09, 0.19, 0.36) });

      const tableTop = height - 342;
      const rowH = 28;
      const colX = [42, 295, 375, 455, 553];

      // Cabeçalho da Tabela
      p1.drawRectangle({ x: colX[0], y: tableTop - rowH, width: colX[4] - colX[0], height: rowH, color: rgb(0.15, 0.29, 0.52) });
      p1.drawText('Descrição do Item', { x: colX[0] + 10, y: tableTop - 18, size: 10, font: fontBold, color: rgb(1, 1, 1) });
      p1.drawText('Qtd.', { x: colX[1] + 14, y: tableTop - 18, size: 10, font: fontBold, color: rgb(1, 1, 1) });
      p1.drawText('Unitário', { x: colX[2] + 10, y: tableTop - 18, size: 10, font: fontBold, color: rgb(1, 1, 1) });
      p1.drawText('Total', { x: colX[3] + 16, y: tableTop - 18, size: 10, font: fontBold, color: rgb(1, 1, 1) });

      const rows = [
        ['Arquitetura & Engenharia Front-end', '01', 'R$ 8.500,00', 'R$ 8.500,00'],
        ['Integração de Assinatura Digital e PDF', '01', 'R$ 4.200,00', 'R$ 4.200,00'],
        ['Testes de Qualidade e Homologação', '02', 'R$ 1.650,00', 'R$ 3.300,00'],
        ['Suporte Técnico e Treinamento', '01', 'R$ 1.800,00', 'R$ 1.800,00']
      ];

      rows.forEach((r, idx) => {
        const y = tableTop - rowH * (idx + 2);
        const bg = idx % 2 === 0 ? rgb(1, 1, 1) : rgb(0.95, 0.97, 1);
        p1.drawRectangle({
          x: colX[0], y, width: colX[4] - colX[0], height: rowH,
          color: bg, borderColor: rgb(0.84, 0.88, 0.93), borderWidth: 0.7
        });
        p1.drawText(r[0], { x: colX[0] + 10, y: y + 10, size: 9.8, font: fontReg, color: rgb(0.12, 0.16, 0.22) });
        p1.drawText(r[1], { x: colX[1] + 18, y: y + 10, size: 9.8, font: fontReg, color: rgb(0.12, 0.16, 0.22) });
        p1.drawText(r[2], { x: colX[2] + 10, y: y + 10, size: 9.8, font: fontReg, color: rgb(0.12, 0.16, 0.22) });
        p1.drawText(r[3], { x: colX[3] + 10, y: y + 10, size: 9.8, font: fontBold, color: rgb(0.09, 0.19, 0.36) });
      });

      // Linha de Total
      const totalY = tableTop - rowH * (rows.length + 2);
      p1.drawRectangle({ x: colX[0], y: totalY, width: colX[4] - colX[0], height: 32, color: rgb(0.91, 0.95, 0.99), borderColor: rgb(0.15, 0.29, 0.52), borderWidth: 1 });
      p1.drawText('INVESTIMENTO TOTAL ESTIMADO', { x: colX[0] + 10, y: totalY + 11, size: 10.5, font: fontBold, color: rgb(0.09, 0.19, 0.36) });
      p1.drawText('R$ 17.800,00', { x: colX[3] + 6, y: totalY + 11, size: 11.5, font: fontBold, color: rgb(0.06, 0.45, 0.26) });

      // Caixa de Observações
      p1.drawRectangle({ x: 42, y: 120, width: width - 84, height: 110, color: rgb(1, 0.98, 0.92), borderColor: rgb(0.92, 0.78, 0.42), borderWidth: 1 });
      p1.drawText('Observações Importantes:', { x: 56, y: 205, size: 10.5, font: fontBold, color: rgb(0.55, 0.36, 0.05) });
      p1.drawText('- Todos os valores podem ser editados clicando diretamente sobre os números na tabela.', { x: 56, y: 184, size: 9.5, font: fontReg, color: rgb(0.32, 0.25, 0.1) });
      p1.drawText('- Experimente adicionar destaques, comentários, imagens, formas e campos de formulário.', { x: 56, y: 166, size: 9.5, font: fontReg, color: rgb(0.32, 0.25, 0.1) });
      p1.drawText('- Na página 2 há uma área dedicada para assinatura digital e preenchimento cadastral.', { x: 56, y: 148, size: 9.5, font: fontReg, color: rgb(0.32, 0.25, 0.1) });

      p1.drawText('Página 1 de 2  •  PDF Studio Pro', { x: 42, y: 34, size: 8.5, font: fontReg, color: rgb(0.45, 0.5, 0.58) });

      // ---------- PÁGINA 2: Termo de Aprovação e Assinatura ----------
      const p2 = doc.addPage([595.28, 841.89]);
      p2.drawRectangle({ x: 0, y: height - 72, width, height: 72, color: rgb(0.09, 0.19, 0.36) });
      p2.drawText('TERMO DE APROVAÇÃO E ASSINATURA', { x: 42, y: height - 44, size: 16, font: fontBold, color: rgb(1, 1, 1) });

      p2.drawText('Declaro estar de acordo com o escopo técnico, prazos e condições comerciais descritas na página 1.', {
        x: 42, y: height - 120, size: 11, font: fontReg, color: rgb(0.15, 0.18, 0.22)
      });

      p2.drawText('Nome do Responsável:', { x: 42, y: height - 175, size: 10, font: fontBold, color: rgb(0.2, 0.25, 0.32) });
      p2.drawLine({ start: { x: 165, y: height - 177 }, end: { x: 540, y: height - 177 }, thickness: 0.9, color: rgb(0.6, 0.65, 0.72) });

      p2.drawText('Cargo / Departamento:', { x: 42, y: height - 215, size: 10, font: fontBold, color: rgb(0.2, 0.25, 0.32) });
      p2.drawLine({ start: { x: 165, y: height - 217 }, end: { x: 540, y: height - 217 }, thickness: 0.9, color: rgb(0.6, 0.65, 0.72) });

      p2.drawText('Local e Data:', { x: 42, y: height - 255, size: 10, font: fontBold, color: rgb(0.2, 0.25, 0.32) });
      p2.drawLine({ start: { x: 165, y: height - 257 }, end: { x: 540, y: height - 257 }, thickness: 0.9, color: rgb(0.6, 0.65, 0.72) });

      // Quadro de Assinatura
      p2.drawRectangle({ x: 42, y: height - 455, width: 240, height: 120, color: rgb(0.98, 0.99, 1), borderColor: rgb(0.75, 0.8, 0.88), borderWidth: 1 });
      p2.drawLine({ start: { x: 62, y: height - 420 }, end: { x: 262, y: height - 420 }, thickness: 0.8, color: rgb(0.4, 0.45, 0.55) });
      p2.drawText('Assinatura do Contratante', { x: 104, y: height - 436, size: 9.5, font: fontReg, color: rgb(0.35, 0.4, 0.5) });

      p2.drawRectangle({ x: 313, y: height - 455, width: 240, height: 120, color: rgb(0.98, 0.99, 1), borderColor: rgb(0.75, 0.8, 0.88), borderWidth: 1 });
      p2.drawLine({ start: { x: 333, y: height - 420 }, end: { x: 533, y: height - 420 }, thickness: 0.8, color: rgb(0.4, 0.45, 0.55) });
      p2.drawText('Assinatura do Fornecedor', { x: 378, y: height - 436, size: 9.5, font: fontReg, color: rgb(0.35, 0.4, 0.5) });

      p2.drawText('Página 2 de 2  •  PDF Studio Pro', { x: 42, y: 34, size: 8.5, font: fontReg, color: rgb(0.45, 0.5, 0.58) });

      return await doc.save();
    },

    async createBlankPdf() {
      const { PDFDocument } = PDFLib;
      const doc = await PDFDocument.create();
      doc.addPage([595.28, 841.89]);
      return await doc.save();
    }
  };

  /* ==========================================================================
     5. SIGNATURE MANAGER (MODAL DE ASSINATURA DIGITAL)
     ========================================================================== */
  class SignatureManager {
    constructor(onInsert) {
      this.onInsert = onInsert;
      this.activeTab = 'draw';
      this.drawing = false;
      this.hasDrawn = false;
      this.uploadedDataUrl = null;
      this.selectedFont = "italic 42px 'Brush Script MT', 'Segoe Script', cursive";
      this.savedSignatures = [];
      this.targetFormObjId = null;

      this.modal = document.getElementById('signatureModal');
      this.canvas = document.getElementById('sigCanvas');
      this.ctx = this.canvas.getContext('2d');
      this.initEvents();
    }

    initEvents() {
      // Abas do modal
      this.modal.querySelectorAll('.modal-tab').forEach(btn => {
        btn.addEventListener('click', () => {
          this.activeTab = btn.dataset.sigTab;
          this.modal.querySelectorAll('.modal-tab').forEach(b => b.classList.toggle('active', b === btn));
          document.getElementById('sigTabDraw').classList.toggle('active', this.activeTab === 'draw');
          document.getElementById('sigTabType').classList.toggle('active', this.activeTab === 'type');
          document.getElementById('sigTabUpload').classList.toggle('active', this.activeTab === 'upload');
        });
      });

      // Desenho suave no canvas (mouse + touch via Pointer Events)
      const getPos = (e) => {
        const rect = this.canvas.getBoundingClientRect();
        return {
          x: (e.clientX - rect.left) * (this.canvas.width / rect.width),
          y: (e.clientY - rect.top) * (this.canvas.height / rect.height)
        };
      };

      this.canvas.addEventListener('pointerdown', (e) => {
        this.drawing = true;
        this.hasDrawn = true;
        this.canvas.setPointerCapture(e.pointerId);
        const p = getPos(e);
        this.ctx.beginPath();
        this.ctx.moveTo(p.x, p.y);
        this.ctx.lineCap = 'round';
        this.ctx.lineJoin = 'round';
        this.ctx.strokeStyle = document.getElementById('sigInkColor').value;
        this.ctx.lineWidth = parseFloat(document.getElementById('sigInkWidth').value) || 2.5;
      });

      this.canvas.addEventListener('pointermove', (e) => {
        if (!this.drawing) return;
        const p = getPos(e);
        this.ctx.lineTo(p.x, p.y);
        this.ctx.stroke();
      });

      const stopDraw = () => { this.drawing = false; };
      this.canvas.addEventListener('pointerup', stopDraw);
      this.canvas.addEventListener('pointercancel', stopDraw);

      document.getElementById('btnSigClear').addEventListener('click', () => this.clearCanvas());

      // Aba Digitar
      const typeInput = document.getElementById('sigTypeInput');
      const typeColor = document.getElementById('sigTypeColor');
      const fontButtons = document.querySelectorAll('.sig-font-opt');

      const updateTypedPreviews = () => {
        const text = typeInput.value.trim() || 'Sua Assinatura';
        fontButtons.forEach(btn => {
          btn.style.font = btn.dataset.font;
          btn.style.color = typeColor.value;
          btn.textContent = text;
        });
      };

      typeInput.addEventListener('input', updateTypedPreviews);
      typeColor.addEventListener('input', updateTypedPreviews);
      fontButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          fontButtons.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.selectedFont = btn.dataset.font;
        });
      });
      updateTypedPreviews();

      // Aba Upload
      document.getElementById('sigImageUpload').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          this.uploadedDataUrl = reader.result;
          const preview = document.getElementById('sigUploadPreview');
          preview.src = this.uploadedDataUrl;
          preview.hidden = false;
        };
        reader.readAsDataURL(file);
      });

      // Botão Inserir
      document.getElementById('btnSigInsert').addEventListener('click', () => {
        const dataUrl = this.exportSignatureDataUrl();
        if (!dataUrl) {
          Utils.toast('Desenhe, digite ou carregue uma assinatura antes de inserir.', 'warning');
          return;
        }
        this.saveSignature(dataUrl);
        this.close();
        this.onInsert(dataUrl, this.targetFormObjId);
        this.targetFormObjId = null;
      });
    }

    open(targetFormObjId = null) {
      this.targetFormObjId = targetFormObjId;
      this.modal.hidden = false;
      this.renderSavedList();
    }

    close() {
      this.modal.hidden = true;
    }

    clearCanvas() {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.hasDrawn = false;
    }

    exportSignatureDataUrl() {
      if (this.activeTab === 'draw') {
        if (!this.hasDrawn) return null;
        return this.trimCanvasToDataUrl(this.canvas);
      }
      if (this.activeTab === 'type') {
        const text = document.getElementById('sigTypeInput').value.trim();
        if (!text) return null;
        const c = document.createElement('canvas');
        c.width = 640;
        c.height = 170;
        const ctx = c.getContext('2d');
        ctx.font = this.selectedFont;
        ctx.fillStyle = document.getElementById('sigTypeColor').value;
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 24, 88);
        return this.trimCanvasToDataUrl(c);
      }
      if (this.activeTab === 'upload') {
        return this.uploadedDataUrl;
      }
      return null;
    }

    trimCanvasToDataUrl(sourceCanvas) {
      const ctx = sourceCanvas.getContext('2d');
      const { width, height } = sourceCanvas;
      const data = ctx.getImageData(0, 0, width, height).data;
      let minX = width, minY = height, maxX = 0, maxY = 0, found = false;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (data[(y * width + x) * 4 + 3] > 10) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            found = true;
          }
        }
      }
      if (!found) return null;
      const pad = 10;
      const sx = Math.max(0, minX - pad);
      const sy = Math.max(0, minY - pad);
      const sw = Math.min(width - sx, maxX - minX + pad * 2);
      const sh = Math.min(height - sy, maxY - minY + pad * 2);
      const out = document.createElement('canvas');
      out.width = sw;
      out.height = sh;
      out.getContext('2d').drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
      return out.toDataURL('image/png');
    }

    saveSignature(dataUrl) {
      if (!this.savedSignatures.includes(dataUrl)) {
        this.savedSignatures.unshift(dataUrl);
        if (this.savedSignatures.length > 6) this.savedSignatures.pop();
      }
    }

    renderSavedList() {
      const wrap = document.getElementById('savedSignaturesWrap');
      const list = document.getElementById('savedSignaturesList');
      if (!this.savedSignatures.length) {
        wrap.hidden = true;
        return;
      }
      wrap.hidden = false;
      list.innerHTML = '';
      this.savedSignatures.forEach((src) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'saved-sig-chip';
        btn.title = 'Usar assinatura salva';
        const img = document.createElement('img');
        img.src = src;
        btn.appendChild(img);
        btn.addEventListener('click', () => {
          this.close();
          this.onInsert(src, this.targetFormObjId);
          this.targetFormObjId = null;
        });
        list.appendChild(btn);
      });
    }
  }

  /* ==========================================================================
     6. OCR MANAGER (TESSERACT.JS SOB DEMANDA PARA PDFs ESCANEADOS)
     ========================================================================== */
  const OCRManager = {
    scriptLoaded: false,

    async ensureTesseract() {
      if (window.Tesseract) return window.Tesseract;
      if (this.scriptLoaded) return window.Tesseract;
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
        s.onload = () => { this.scriptLoaded = true; resolve(); };
        s.onerror = () => reject(new Error('Não foi possível carregar o motor OCR (verifique conexão com a internet).'));
        document.head.appendChild(s);
      });
      return window.Tesseract;
    },

    async recognizePage(pdfEngine, pageIndex, lang, onProgress) {
      const Tesseract = await this.ensureTesseract();
      const page = await pdfEngine.pdfDoc.getPage(pageIndex + 1);
      const scale = 2.0;
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

      const result = await Tesseract.recognize(canvas, lang, {
        logger: (m) => {
          if (m.status === 'recognizing text' && onProgress) {
            onProgress(Math.round((m.progress || 0) * 100));
          }
        }
      });

      const lines = result.data.lines || [];
      const runs = [];
      for (const line of lines) {
        const text = (line.text || '').trim();
        if (!text) continue;
        const b = line.bbox;
        const x = b.x0 / scale;
        const y = b.y0 / scale;
        const w = Math.max((b.x1 - b.x0) / scale, 10);
        const h = Math.max((b.y1 - b.y0) / scale, 8);
        const fontSize = Utils.clamp(Utils.round1(h * 0.82), 7, 72);

        runs.push({
          id: Utils.uid(`ocr_${pageIndex}`),
          pageIndex,
          origX: Utils.round1(x),
          origY: Utils.round1(y),
          origW: Utils.round1(w),
          origH: Utils.round1(h),
          origText: text,
          origFontFamily: 'Helvetica, Arial, sans-serif',
          origFontSize: fontSize,
          origBold: false,
          origItalic: false,
          x: Utils.round1(x),
          y: Utils.round1(y),
          width: Utils.round1(w),
          height: Utils.round1(h),
          rotation: 0,
          opacity: 1,
          text,
          fontFamily: 'Helvetica, Arial, sans-serif',
          fontSize,
          color: '#111111',
          maskColor: '#ffffff',
          colorSampled: false,
          bold: false,
          italic: false,
          underline: false,
          strikethrough: false,
          align: 'left',
          lineHeight: 1.15,
          edited: false,
          moved: false,
          deleted: false,
          fromOcr: true
        });
      }
      return runs;
    }
  };

  /* ==========================================================================
     7. PDF EXPORTER (3 MODOS: ORIGINAL, EDITÁVEL E FINAL)
     ========================================================================== */
  class PDFExporter {
    constructor(pdfEngine) {
      this.pdfEngine = pdfEngine;
    }

    /**
     * Calcula a posição (x, y) compensada para rotação em torno do centro no pdf-lib.
     */
    rotatedRectOrigin(x, yTop, w, h, pageH, rotDeg) {
      const cx = x + w / 2;
      const cy = pageH - (yTop + h / 2);
      const rad = (-rotDeg * Math.PI) / 180; // CSS clockwise -> PDF counter-clockwise
      const dx = -w / 2;
      const dy = -h / 2;
      const rx = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
      const ry = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
      return { x: rx, y: ry, angleDeg: -rotDeg };
    }

    /**
     * Renderiza texto com caracteres fora de WinAnsi ou alinhamento justificado/efeitos
     * em PNG 3x transparente como fallback seguro (evita qualquer erro de encoding).
     */
    async rasterizeTextToPng(item) {
      const scale = 3;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(4, Math.ceil((item.width + 6) * scale));
      canvas.height = Math.max(4, Math.ceil((item.height + 6) * scale));
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);

      if (item.bgColor && !item.bgTransparent) {
        ctx.fillStyle = item.bgColor;
        ctx.fillRect(0, 0, item.width, item.height);
      }

      const weight = item.bold ? 'bold' : 'normal';
      const style = item.italic ? 'italic' : 'normal';
      ctx.font = `${style} ${weight} ${item.fontSize}px ${item.fontFamily}`;
      ctx.fillStyle = item.color || '#111111';
      ctx.textBaseline = 'top';

      const lineH = item.fontSize * (item.lineHeight || 1.15);
      const lines = Utils.wrapTextLines(item.text, Math.max(item.width - 4, 12), (s) => ctx.measureText(s).width);

      lines.forEach((line, idx) => {
        const ly = idx * lineH + 1;
        const lw = ctx.measureText(line).width;
        let lx = 2;
        if (item.align === 'center') lx = Math.max(2, (item.width - lw) / 2);
        else if (item.align === 'right') lx = Math.max(2, item.width - lw - 2);
        ctx.fillText(line, lx, ly);

        if (item.underline) {
          ctx.fillRect(lx, ly + item.fontSize * 0.92, lw, Math.max(0.8, item.fontSize * 0.06));
        }
        if (item.strikethrough) {
          ctx.fillRect(lx, ly + item.fontSize * 0.48, lw, Math.max(0.8, item.fontSize * 0.06));
        }
      });

      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      return new Uint8Array(await blob.arrayBuffer());
    }

    /**
     * Desenha texto vetorial no pdf-lib preservando alinhamento, espaçamento, sublinhado e tachado.
     */
    async drawTextBlock(pdfDoc, page, item, fontCache) {
      const { rgb, degrees } = PDFLib;
      const pageH = page.getHeight();
      const rot = item.rotation || 0;
      const opacity = item.opacity != null ? item.opacity : 1;

      // Fundo da caixa de texto (se não transparente)
      if (item.bgColor && !item.bgTransparent) {
        const bg = Utils.hexToRgb01(item.bgColor);
        const pos = this.rotatedRectOrigin(item.x, item.y, item.width, item.height, pageH, rot);
        page.drawRectangle({
          x: pos.x, y: pos.y, width: item.width, height: item.height,
          color: rgb(bg.r, bg.g, bg.b), opacity,
          rotate: degrees(pos.angleDeg)
        });
      }

      const text = String(item.text || '');
      if (!text.trim()) return;

      // Fallback para Unicode fora de WinAnsi ou texto rotacionado multilinha
      if (!Utils.isWinAnsiSafe(text) || (rot !== 0 && text.includes('\n'))) {
        const pngBytes = await this.rasterizeTextToPng({ ...item, bgTransparent: true });
        const img = await pdfDoc.embedPng(pngBytes);
        const pos = this.rotatedRectOrigin(item.x, item.y, item.width + 6, item.height + 6, pageH, rot);
        page.drawImage(img, {
          x: pos.x, y: pos.y, width: item.width + 6, height: item.height + 6,
          opacity, rotate: degrees(pos.angleDeg)
        });
        return;
      }

      const fontKey = Utils.getStandardFontKey(item.fontFamily, item.bold, item.italic);
      if (!fontCache.has(fontKey)) {
        fontCache.set(fontKey, await pdfDoc.embedFont(fontKey));
      }
      const font = fontCache.get(fontKey);
      const size = Math.max(4, item.fontSize || 12);
      const lineH = size * (item.lineHeight || 1.15);
      const col = Utils.hexToRgb01(item.color || '#111111');
      const maxW = Math.max(item.width - 2, size * 2);

      const lines = Utils.wrapTextLines(text, maxW, (s) => font.widthOfTextAtSize(s, size));

      lines.forEach((line, idx) => {
        if (!line) return;
        const lineW = font.widthOfTextAtSize(line, size);
        let offsetX = 1;
        if (item.align === 'center') offsetX = Math.max(1, (item.width - lineW) / 2);
        else if (item.align === 'right') offsetX = Math.max(1, item.width - lineW - 1);

        const lineTopY = item.y + idx * lineH;
        const baselinePdfY = pageH - (lineTopY + size * 0.88);
        const drawX = item.x + offsetX;

        if (item.align === 'justify' && idx < lines.length - 1 && line.includes(' ') && rot === 0) {
          const words = line.trim().split(/\s+/);
          if (words.length > 1) {
            const wordsWidth = words.reduce((acc, w) => acc + font.widthOfTextAtSize(w, size), 0);
            const spaceW = Math.max(2, (maxW - wordsWidth) / (words.length - 1));
            let cursorX = item.x + 1;
            words.forEach(w => {
              page.drawText(w, { x: cursorX, y: baselinePdfY, size, font, color: rgb(col.r, col.g, col.b), opacity });
              cursorX += font.widthOfTextAtSize(w, size) + spaceW;
            });
          } else {
            page.drawText(line, { x: drawX, y: baselinePdfY, size, font, color: rgb(col.r, col.g, col.b), opacity });
          }
        } else {
          page.drawText(line, {
            x: drawX,
            y: baselinePdfY,
            size,
            font,
            color: rgb(col.r, col.g, col.b),
            opacity,
            rotate: degrees(-rot)
          });
        }

        // Sublinhado e Tachado vetoriais
        const decoThick = Math.max(0.6, size * 0.065);
        if (item.underline && rot === 0) {
          page.drawLine({
            start: { x: drawX, y: baselinePdfY - size * 0.14 },
            end: { x: drawX + lineW, y: baselinePdfY - size * 0.14 },
            thickness: decoThick, color: rgb(col.r, col.g, col.b), opacity
          });
        }
        if (item.strikethrough && rot === 0) {
          page.drawLine({
            start: { x: drawX, y: baselinePdfY + size * 0.3 },
            end: { x: drawX + lineW, y: baselinePdfY + size * 0.3 },
            thickness: decoThick, color: rgb(col.r, col.g, col.b), opacity
          });
        }
      });
    }

    /**
     * Modo 1 & 2: Constrói PDF vetorial nativo via pdf-lib sobre os bytes originais.
     */
    async exportVectorPdf(pagesState, { editable = false, flattenForms = false, onProgress } = {}) {
      const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
      if (onProgress) onProgress(10, 'Carregando estrutura original do PDF...');

      const pdfDoc = await PDFDocument.load(this.pdfEngine.originalBytes.slice(), {
        ignoreEncryption: true
      });
      pdfDoc.setCreator('PDF Studio Pro');
      pdfDoc.setProducer('PDF Studio Pro (pdf-lib)');

      const fontCache = new Map();
      const form = pdfDoc.getForm();
      const radioGroups = new Map();
      const usedFieldNames = new Set();

      const uniqueFieldName = (base) => {
        let name = (base || 'campo').replace(/[^a-zA-Z0-9_-]/g, '_') || 'campo';
        let i = 1;
        let candidate = name;
        while (usedFieldNames.has(candidate)) {
          candidate = `${name}_${i++}`;
        }
        usedFieldNames.add(candidate);
        return candidate;
      };

      const pages = pdfDoc.getPages();

      for (let pIdx = 0; pIdx < pages.length; pIdx++) {
        if (onProgress) {
          const pct = 15 + Math.round(((pIdx + 1) / pages.length) * 70);
          onProgress(pct, `Processando página ${pIdx + 1} de ${pages.length}...`);
        }

        const page = pages[pIdx];
        const pageH = page.getHeight();
        const pData = pagesState[pIdx];
        if (!pData) continue;

        // 1. Máscaras de texto original editado, movido ou excluído
        for (const run of pData.textRuns) {
          if (run.edited || run.moved || run.deleted) {
            const maskCol = Utils.hexToRgb01(run.maskColor || '#ffffff');
            page.drawRectangle({
              x: run.origX - 1.5,
              y: pageH - (run.origY + run.origH) - 1.5,
              width: run.origW + 3,
              height: run.origH + 3,
              color: rgb(maskCol.r, maskCol.g, maskCol.b)
            });
          }
        }

        // 2. Textos originais editados / movidos (não excluídos)
        for (const run of pData.textRuns) {
          if ((run.edited || run.moved) && !run.deleted) {
            await this.drawTextBlock(pdfDoc, page, {
              ...run,
              bgTransparent: true
            }, fontCache);
          }
        }

        // 3. Objetos ordenados por zIndex
        const sortedObjs = [...pData.objects].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

        for (const obj of sortedObjs) {
          const op = obj.opacity != null ? obj.opacity : 1;
          const rot = obj.rotation || 0;

          if (obj.type === 'highlight') {
            const c = Utils.hexToRgb01(obj.color || '#fde047');
            const pos = this.rotatedRectOrigin(obj.x, obj.y, obj.width, obj.height, pageH, rot);
            page.drawRectangle({
              x: pos.x, y: pos.y, width: obj.width, height: obj.height,
              color: rgb(c.r, c.g, c.b),
              opacity: Math.min(op, 0.38),
              rotate: degrees(pos.angleDeg)
            });
          } else if (obj.type === 'textbox') {
            await this.drawTextBlock(pdfDoc, page, obj, fontCache);
          } else if (obj.type === 'image' || obj.type === 'signature') {
            if (!obj.dataUrl) continue;
            try {
              const pngBytes = await Utils.dataUrlToPngBytes(obj.dataUrl);
              const embedded = await pdfDoc.embedPng(pngBytes);
              const pos = this.rotatedRectOrigin(obj.x, obj.y, obj.width, obj.height, pageH, rot);
              page.drawImage(embedded, {
                x: pos.x, y: pos.y, width: obj.width, height: obj.height,
                opacity: op, rotate: degrees(pos.angleDeg)
              });
            } catch (e) {
              console.warn('Imagem ignorada na exportação:', e);
            }
          } else if (obj.type === 'shape') {
            const sc = Utils.hexToRgb01(obj.strokeColor || '#2563eb');
            const fc = Utils.hexToRgb01(obj.fillColor || '#3b82f6');
            const sw = obj.strokeWidth != null ? obj.strokeWidth : 2;
            const hasFill = !obj.fillTransparent;

            if (obj.shapeType === 'rect') {
              const pos = this.rotatedRectOrigin(obj.x, obj.y, obj.width, obj.height, pageH, rot);
              page.drawRectangle({
                x: pos.x, y: pos.y, width: obj.width, height: obj.height,
                borderColor: sw > 0 ? rgb(sc.r, sc.g, sc.b) : undefined,
                borderWidth: sw,
                color: hasFill ? rgb(fc.r, fc.g, fc.b) : undefined,
                opacity: hasFill ? op : undefined,
                borderOpacity: op,
                rotate: degrees(pos.angleDeg)
              });
            } else if (obj.shapeType === 'ellipse') {
              page.drawEllipse({
                x: obj.x + obj.width / 2,
                y: pageH - (obj.y + obj.height / 2),
                xScale: obj.width / 2,
                yScale: obj.height / 2,
                borderColor: sw > 0 ? rgb(sc.r, sc.g, sc.b) : undefined,
                borderWidth: sw,
                color: hasFill ? rgb(fc.r, fc.g, fc.b) : undefined,
                opacity: hasFill ? op : undefined,
                borderOpacity: op
              });
            } else if (obj.shapeType === 'line' || obj.shapeType === 'arrow') {
              const cx = obj.x + obj.width / 2;
              const cy = pageH - (obj.y + obj.height / 2);
              const rad = (-rot * Math.PI) / 180;
              const rotPt = (px, py) => ({
                x: cx + (px - cx) * Math.cos(rad) - (py - cy) * Math.sin(rad),
                y: cy + (px - cx) * Math.sin(rad) + (py - cy) * Math.cos(rad)
              });
              const pStart = rotPt(obj.x, pageH - (obj.y + obj.height / 2));
              const pEnd = rotPt(obj.x + obj.width, pageH - (obj.y + obj.height / 2));

              page.drawLine({
                start: pStart, end: pEnd,
                thickness: Math.max(1, sw),
                color: rgb(sc.r, sc.g, sc.b),
                opacity: op
              });

              if (obj.shapeType === 'arrow') {
                const ang = Math.atan2(pEnd.y - pStart.y, pEnd.x - pStart.x);
                const headLen = Math.max(8, sw * 4.5);
                const a1 = ang - Math.PI / 6;
                const a2 = ang + Math.PI / 6;
                page.drawLine({
                  start: pEnd,
                  end: { x: pEnd.x - headLen * Math.cos(a1), y: pEnd.y - headLen * Math.sin(a1) },
                  thickness: Math.max(1, sw), color: rgb(sc.r, sc.g, sc.b), opacity: op
                });
                page.drawLine({
                  start: pEnd,
                  end: { x: pEnd.x - headLen * Math.cos(a2), y: pEnd.y - headLen * Math.sin(a2) },
                  thickness: Math.max(1, sw), color: rgb(sc.r, sc.g, sc.b), opacity: op
                });
              }
            }
          } else if (obj.type === 'draw' && obj.points && obj.points.length > 1) {
            const sc = Utils.hexToRgb01(obj.strokeColor || '#2563eb');
            const sw = Math.max(1, obj.strokeWidth || 2);
            const cx = obj.x + obj.width / 2;
            const cy = pageH - (obj.y + obj.height / 2);
            const rad = (-rot * Math.PI) / 180;
            const mapPt = (pt) => {
              const absX = obj.x + pt.x * obj.width;
              const absY = pageH - (obj.y + pt.y * obj.height);
              if (!rot) return { x: absX, y: absY };
              return {
                x: cx + (absX - cx) * Math.cos(rad) - (absY - cy) * Math.sin(rad),
                y: cy + (absX - cx) * Math.sin(rad) + (absY - cy) * Math.cos(rad)
              };
            };
            for (let i = 1; i < obj.points.length; i++) {
              page.drawLine({
                start: mapPt(obj.points[i - 1]),
                end: mapPt(obj.points[i]),
                thickness: sw,
                color: rgb(sc.r, sc.g, sc.b),
                opacity: op
              });
            }
          } else if (obj.type === 'comment') {
            // Desenha marcador visual de comentário + nota compacta se tiver texto
            const yPdf = pageH - (obj.y + obj.height);
            page.drawCircle({
              x: obj.x + obj.width / 2,
              y: yPdf + obj.height / 2,
              size: obj.width / 2,
              color: rgb(0.98, 0.8, 0.08),
              borderColor: rgb(0.63, 0.38, 0.03),
              borderWidth: 1.4
            });
            if (!fontCache.has(StandardFonts.HelveticaBold)) {
              fontCache.set(StandardFonts.HelveticaBold, await pdfDoc.embedFont(StandardFonts.HelveticaBold));
            }
            const fBold = fontCache.get(StandardFonts.HelveticaBold);
            page.drawText('!', {
              x: obj.x + obj.width / 2 - 2.5,
              y: yPdf + obj.height / 2 - 4,
              size: 11, font: fBold, color: rgb(0.26, 0.13, 0.02)
            });

            if (obj.text && obj.text.trim()) {
              const noteX = Math.min(obj.x + obj.width + 6, page.getWidth() - 165);
              const noteW = 155;
              const noteH = 44;
              const noteY = Math.max(10, yPdf - 14);
              page.drawRectangle({
                x: noteX, y: noteY, width: noteW, height: noteH,
                color: rgb(0.996, 0.976, 0.76),
                borderColor: rgb(0.85, 0.65, 0.05),
                borderWidth: 0.8
              });
              const safeLabel = Utils.isWinAnsiSafe(obj.text) ? obj.text.slice(0, 65) : 'Comentario';
              page.drawText(safeLabel, {
                x: noteX + 5, y: noteY + noteH - 14, size: 7.5,
                font: fBold, color: rgb(0.15, 0.15, 0.15), maxWidth: noteW - 10, lineHeight: 9
              });
            }
          } else if (obj.type === 'form') {
            const yPdf = pageH - (obj.y + obj.height);
            const fName = uniqueFieldName(obj.fieldName || `campo_${obj.formType}`);

            if (obj.formType === 'text') {
              const tf = form.createTextField(fName);
              if (obj.value && Utils.isWinAnsiSafe(obj.value)) tf.setText(obj.value);
              tf.addToPage(page, {
                x: obj.x, y: yPdf, width: obj.width, height: obj.height,
                borderWidth: 1, borderColor: rgb(0.15, 0.39, 0.92), backgroundColor: rgb(0.94, 0.97, 1)
              });
            } else if (obj.formType === 'checkbox') {
              const cb = form.createCheckBox(fName);
              cb.addToPage(page, {
                x: obj.x, y: yPdf, width: obj.width, height: obj.height,
                borderWidth: 1, borderColor: rgb(0.15, 0.39, 0.92), backgroundColor: rgb(0.96, 0.98, 1)
              });
              if (obj.checked) cb.check();
            } else if (obj.formType === 'radio') {
              const gName = (obj.radioGroup || 'grupo_radio').replace(/[^a-zA-Z0-9_-]/g, '_');
              let rg = radioGroups.get(gName);
              if (!rg) {
                rg = form.createRadioGroup(uniqueFieldName(gName));
                radioGroups.set(gName, rg);
              }
              const optVal = obj.value || fName;
              rg.addOptionToPage(optVal, page, {
                x: obj.x, y: yPdf, width: obj.width, height: obj.height,
                borderWidth: 1, borderColor: rgb(0.15, 0.39, 0.92), backgroundColor: rgb(0.96, 0.98, 1)
              });
              if (obj.checked) rg.select(optVal);
            } else if (obj.formType === 'dropdown') {
              const dd = form.createDropdown(fName);
              const opts = (obj.options && obj.options.length ? obj.options : ['Opção 1', 'Opção 2'])
                .map(o => (Utils.isWinAnsiSafe(o) ? o : 'Opcao'));
              dd.addOptions(opts);
              if (obj.value && opts.includes(obj.value)) dd.select(obj.value);
              dd.addToPage(page, {
                x: obj.x, y: yPdf, width: obj.width, height: obj.height,
                borderWidth: 1, borderColor: rgb(0.15, 0.39, 0.92), backgroundColor: rgb(0.94, 0.97, 1)
              });
            } else if (obj.formType === 'signature') {
              page.drawRectangle({
                x: obj.x, y: yPdf, width: obj.width, height: obj.height,
                borderWidth: 1, borderColor: rgb(0.15, 0.39, 0.92),
                color: rgb(0.95, 0.97, 1)
              });
              if (obj.signatureDataUrl) {
                const pngBytes = await Utils.dataUrlToPngBytes(obj.signatureDataUrl);
                const sigImg = await pdfDoc.embedPng(pngBytes);
                page.drawImage(sigImg, {
                  x: obj.x + 4, y: yPdf + 4,
                  width: Math.max(10, obj.width - 8),
                  height: Math.max(10, obj.height - 8)
                });
              } else {
                const tf = form.createTextField(fName);
                tf.setText('Assinar aqui');
                tf.addToPage(page, {
                  x: obj.x, y: yPdf, width: obj.width, height: obj.height,
                  borderWidth: 1, borderColor: rgb(0.15, 0.39, 0.92)
                });
              }
            }
          }
        }
      }

      if (flattenForms) {
        try { form.flatten(); } catch (e) { console.warn('Aviso ao achatar formulário:', e); }
      }

      // No modo "PDF Editável", embutimos o estado completo das camadas em anexo JSON
      if (editable) {
        if (onProgress) onProgress(90, 'Embutindo camadas editáveis no PDF...');
        const payload = {
          version: 1,
          exportedAt: new Date().toISOString(),
          pages: pagesState.map(p => ({
            textRuns: p.textRuns.filter(r => r.edited || r.moved || r.deleted || r.fromOcr),
            objects: p.objects
          }))
        };
        const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
        await pdfDoc.attach(jsonBytes, PROJECT_ATTACHMENT_NAME, {
          mimeType: 'application/json',
          description: 'PDF Studio Pro Editable Project State'
        });
      }

      if (onProgress) onProgress(96, 'Finalizando arquivo PDF...');
      return await pdfDoc.save();
    }

    /**
     * Modo 3 (Alta Fidelidade Visual 2.5x DPI): Compõe todas as páginas em canvas
     * de altíssima definição (fontes web, multiply highlight, máscaras, formulários)
     * e empacota em um PDF final achatado visualmente idêntico à tela.
     */
    async exportHighDpiFlattenedPdf(pagesState, { onProgress } = {}) {
      const { PDFDocument } = PDFLib;
      const outDoc = await PDFDocument.create();
      outDoc.setCreator('PDF Studio Pro');
      const dpiScale = 2.5;
      const numPages = this.pdfEngine.pdfDoc.numPages;

      for (let pIdx = 0; pIdx < numPages; pIdx++) {
        if (onProgress) {
          onProgress(10 + Math.round(((pIdx + 1) / numPages) * 82), `Renderizando página final ${pIdx + 1} de ${numPages}...`);
        }

        const page = await this.pdfEngine.pdfDoc.getPage(pIdx + 1);
        const vp1 = page.getViewport({ scale: 1 });
        const vpHi = page.getViewport({ scale: dpiScale });

        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vpHi.width);
        canvas.height = Math.ceil(vpHi.height);
        const ctx = canvas.getContext('2d');

        // Fundo branco + PDF original fiel
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vpHi }).promise;

        ctx.save();
        ctx.scale(dpiScale, dpiScale);

        const pData = pagesState[pIdx];
        if (pData) {
          // 1. Máscaras de texto original editado/movido/excluído
          for (const run of pData.textRuns) {
            if (run.edited || run.moved || run.deleted) {
              ctx.fillStyle = run.maskColor || '#ffffff';
              ctx.fillRect(run.origX - 1.5, run.origY - 1.5, run.origW + 3, run.origH + 3);
            }
          }

          // 2. Textos originais editados/movidos
          for (const run of pData.textRuns) {
            if ((run.edited || run.moved) && !run.deleted) {
              this.paintTextOnCanvas(ctx, { ...run, bgTransparent: true });
            }
          }

          // 3. Objetos em ordem Z
          const sortedObjs = [...pData.objects].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
          for (const obj of sortedObjs) {
            await this.paintObjectOnCanvas(ctx, obj);
          }
        }
        ctx.restore();

        const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.94));
        const jpgBytes = new Uint8Array(await blob.arrayBuffer());
        const jpgImg = await outDoc.embedJpg(jpgBytes);

        const outPage = outDoc.addPage([vp1.width, vp1.height]);
        outPage.drawImage(jpgImg, { x: 0, y: 0, width: vp1.width, height: vp1.height });
      }

      if (onProgress) onProgress(96, 'Compactando PDF final...');
      return await outDoc.save();
    }

    paintTextOnCanvas(ctx, item) {
      ctx.save();
      ctx.globalAlpha = item.opacity != null ? item.opacity : 1;
      const cx = item.x + item.width / 2;
      const cy = item.y + item.height / 2;
      if (item.rotation) {
        ctx.translate(cx, cy);
        ctx.rotate((item.rotation * Math.PI) / 180);
        ctx.translate(-cx, -cy);
      }

      if (item.bgColor && !item.bgTransparent) {
        ctx.fillStyle = item.bgColor;
        ctx.fillRect(item.x, item.y, item.width, item.height);
      }

      const weight = item.bold ? 'bold' : 'normal';
      const style = item.italic ? 'italic' : 'normal';
      ctx.font = `${style} ${weight} ${item.fontSize}px ${item.fontFamily}`;
      ctx.fillStyle = item.color || '#111111';
      ctx.textBaseline = 'top';

      const lineH = item.fontSize * (item.lineHeight || 1.15);
      const lines = Utils.wrapTextLines(item.text, Math.max(item.width - 2, 12), (s) => ctx.measureText(s).width);

      lines.forEach((line, idx) => {
        const ly = item.y + idx * lineH;
        const lw = ctx.measureText(line).width;
        let lx = item.x + 1;
        if (item.align === 'center') lx = item.x + Math.max(1, (item.width - lw) / 2);
        else if (item.align === 'right') lx = item.x + Math.max(1, item.width - lw - 1);

        if (item.align === 'justify' && idx < lines.length - 1 && line.includes(' ')) {
          const words = line.trim().split(/\s+/);
          if (words.length > 1) {
            const ww = words.reduce((a, w) => a + ctx.measureText(w).width, 0);
            const sp = Math.max(2, (item.width - 2 - ww) / (words.length - 1));
            let curX = item.x + 1;
            words.forEach(w => {
              ctx.fillText(w, curX, ly);
              curX += ctx.measureText(w).width + sp;
            });
          } else {
            ctx.fillText(line, lx, ly);
          }
        } else {
          ctx.fillText(line, lx, ly);
        }

        if (item.underline) {
          ctx.fillRect(lx, ly + item.fontSize * 0.94, lw, Math.max(0.7, item.fontSize * 0.065));
        }
        if (item.strikethrough) {
          ctx.fillRect(lx, ly + item.fontSize * 0.48, lw, Math.max(0.7, item.fontSize * 0.065));
        }
      });
      ctx.restore();
    }

    async paintObjectOnCanvas(ctx, obj) {
      ctx.save();
      ctx.globalAlpha = obj.opacity != null ? obj.opacity : 1;
      const cx = obj.x + obj.width / 2;
      const cy = obj.y + obj.height / 2;
      if (obj.rotation) {
        ctx.translate(cx, cy);
        ctx.rotate((obj.rotation * Math.PI) / 180);
        ctx.translate(-cx, -cy);
      }

      if (obj.type === 'textbox') {
        ctx.restore();
        this.paintTextOnCanvas(ctx, obj);
        return;
      }

      if (obj.type === 'highlight') {
        ctx.globalCompositeOperation = 'multiply';
        ctx.fillStyle = obj.color || '#fde047';
        ctx.fillRect(obj.x, obj.y, obj.width, obj.height);
      } else if (obj.type === 'image' || obj.type === 'signature') {
        if (obj.dataUrl) {
          await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => { ctx.drawImage(img, obj.x, obj.y, obj.width, obj.height); resolve(); };
            img.onerror = resolve;
            img.src = obj.dataUrl;
          });
        }
      } else if (obj.type === 'shape') {
        ctx.strokeStyle = obj.strokeColor || '#2563eb';
        ctx.lineWidth = obj.strokeWidth != null ? obj.strokeWidth : 2;
        ctx.fillStyle = obj.fillColor || '#3b82f6';
        if (obj.shapeType === 'rect') {
          if (!obj.fillTransparent) ctx.fillRect(obj.x, obj.y, obj.width, obj.height);
          if (ctx.lineWidth > 0) ctx.strokeRect(obj.x, obj.y, obj.width, obj.height);
        } else if (obj.shapeType === 'ellipse') {
          ctx.beginPath();
          ctx.ellipse(cx, cy, obj.width / 2, obj.height / 2, 0, 0, Math.PI * 2);
          if (!obj.fillTransparent) ctx.fill();
          if (ctx.lineWidth > 0) ctx.stroke();
        } else if (obj.shapeType === 'line' || obj.shapeType === 'arrow') {
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(obj.x, cy);
          ctx.lineTo(obj.x + obj.width, cy);
          ctx.stroke();
          if (obj.shapeType === 'arrow') {
            const hl = Math.max(8, ctx.lineWidth * 4);
            ctx.beginPath();
            ctx.moveTo(obj.x + obj.width, cy);
            ctx.lineTo(obj.x + obj.width - hl, cy - hl * 0.55);
            ctx.moveTo(obj.x + obj.width, cy);
            ctx.lineTo(obj.x + obj.width - hl, cy + hl * 0.55);
            ctx.stroke();
          }
        }
      } else if (obj.type === 'draw' && obj.points && obj.points.length > 1) {
        ctx.strokeStyle = obj.strokeColor || '#2563eb';
        ctx.lineWidth = Math.max(1, obj.strokeWidth || 2);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(obj.x + obj.points[0].x * obj.width, obj.y + obj.points[0].y * obj.height);
        for (let i = 1; i < obj.points.length; i++) {
          ctx.lineTo(obj.x + obj.points[i].x * obj.width, obj.y + obj.points[i].y * obj.height);
        }
        ctx.stroke();
      } else if (obj.type === 'comment') {
        ctx.fillStyle = '#facc15';
        ctx.strokeStyle = '#a16207';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, obj.width / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#422006';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', cx, cy + 1);
      } else if (obj.type === 'form') {
        ctx.fillStyle = 'rgba(219, 234, 254, 0.65)';
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 1;
        ctx.fillRect(obj.x, obj.y, obj.width, obj.height);
        ctx.strokeRect(obj.x, obj.y, obj.width, obj.height);

        ctx.fillStyle = '#0f172a';
        ctx.font = '11px sans-serif';
        ctx.textBaseline = 'middle';
        if (obj.formType === 'text' || obj.formType === 'dropdown') {
          ctx.fillText(obj.value || '', obj.x + 5, cy);
        } else if (obj.formType === 'checkbox' && obj.checked) {
          ctx.strokeStyle = '#1d4ed8';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(obj.x + obj.width * 0.2, cy);
          ctx.lineTo(obj.x + obj.width * 0.45, obj.y + obj.height * 0.78);
          ctx.lineTo(obj.x + obj.width * 0.82, obj.y + obj.height * 0.22);
          ctx.stroke();
        } else if (obj.formType === 'radio' && obj.checked) {
          ctx.fillStyle = '#1d4ed8';
          ctx.beginPath();
          ctx.arc(cx, cy, Math.min(obj.width, obj.height) * 0.28, 0, Math.PI * 2);
          ctx.fill();
        } else if (obj.formType === 'signature' && obj.signatureDataUrl) {
          await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => { ctx.drawImage(img, obj.x + 2, obj.y + 2, obj.width - 4, obj.height - 4); resolve(); };
            img.onerror = resolve;
            img.src = obj.signatureDataUrl;
          });
        }
      }
      ctx.restore();
    }
  }

  /* ==========================================================================
     8. CONTROLADOR PRINCIPAL DA APLICAÇÃO (PDFEditorApp)
     ========================================================================== */
  class PDFEditorApp {
    constructor() {
      this.pdfEngine = new PDFEngine();
      this.exporter = new PDFExporter(this.pdfEngine);
      this.history = new HistoryManager(60);

      // Estado Global
      this.state = {
        fileName: 'documento.pdf',
        numPages: 0,
        currentPage: 0,
        zoom: 1.25,
        tool: 'select',
        shapeType: 'rect',
        formType: 'text',
        pages: [], // [{ width, height, textRuns: [], objects: [] }]
        selected: null, // { kind: 'object' | 'textRun', pageIndex, id }
        clipboard: null,
        zCounter: 10,
        format: {
          fontFamily: 'Helvetica, Arial, sans-serif',
          fontSize: 12,
          color: '#111111',
          bgColor: '#ffffff',
          bgTransparent: true,
          bold: false,
          italic: false,
          underline: false,
          strikethrough: false,
          align: 'left',
          lineHeight: 1.15,
          strokeColor: '#2563eb',
          strokeWidth: 2,
          highlightColor: '#fde047',
          opacity: 1
        }
      };

      this.pageElements = []; // DOM refs por página
      this.renderGeneration = 0;

      this.signatureManager = new SignatureManager((dataUrl, targetFormObjId) => {
        if (targetFormObjId) {
          const found = this.findObjectById(targetFormObjId);
          if (found) {
            found.obj.signatureDataUrl = dataUrl;
            this.pushHistory();
            this.renderPageOverlays(found.pageIndex);
            Utils.toast('Assinatura aplicada ao campo do formulário.', 'success');
            return;
          }
        }
        this.insertImageOrSignature(dataUrl, 'signature');
      });

      this.cacheDom();
      this.bindGlobalEvents();
      this.updateToolUI();
    }

    cacheDom() {
      this.dom = {
        pagesContainer: document.getElementById('pagesContainer'),
        welcomeScreen: document.getElementById('welcomeScreen'),
        welcomeDropzone: document.getElementById('welcomeDropzone'),
        dropOverlay: document.getElementById('dropOverlay'),
        viewport: document.getElementById('viewport'),
        docTitleInput: document.getElementById('docTitleInput'),
        pdfFileInput: document.getElementById('pdfFileInput'),
        imageFileInput: document.getElementById('imageFileInput'),
        pageNumberInput: document.getElementById('pageNumberInput'),
        pageCountLabel: document.getElementById('pageCountLabel'),
        zoomSelect: document.getElementById('zoomSelect'),
        thumbnailsList: document.getElementById('thumbnailsList'),
        layersList: document.getElementById('layersList'),
        layersCountBadge: document.getElementById('layersCountBadge'),
        commentsList: document.getElementById('commentsList'),
        commentsCountBadge: document.getElementById('commentsCountBadge'),
        leftSidebar: document.getElementById('leftSidebar'),
        rightSidebar: document.getElementById('rightSidebar'),
        inspectorEmpty: document.getElementById('inspectorEmpty'),
        inspectorContent: document.getElementById('inspectorContent'),
        selectedTypeBadge: document.getElementById('selectedTypeBadge'),
        contextMenu: document.getElementById('contextMenu'),
        statusToolBadge: document.getElementById('statusToolBadge'),
        statusHint: document.getElementById('statusHint'),
        statusCoords: document.getElementById('statusCoords'),
        statusPageSize: document.getElementById('statusPageSize'),
        statusEditCount: document.getElementById('statusEditCount')
      };
    }

    /* ------------------------------------------------------------------------
       CARREGAMENTO E RENDERIZAÇÃO DE PDF
       ------------------------------------------------------------------------ */
    async openPdfFile(file) {
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        Utils.toast('Por favor, selecione um arquivo PDF válido (.pdf).', 'error');
        return;
      }
      try {
        const buffer = await file.arrayBuffer();
        await this.loadPdfBytes(new Uint8Array(buffer), file.name);
      } catch (err) {
        console.error(err);
        Utils.toast(`Erro ao abrir PDF: ${err.message}`, 'error', 4500);
      }
    }

    async loadPdfBytes(uint8Array, fileName = 'documento.pdf') {
      Utils.toast('Carregando documento PDF...', 'info', 1800);
      const { numPages, embeddedProject } = await this.pdfEngine.loadFromBytes(uint8Array);

      this.state.fileName = fileName;
      this.state.numPages = numPages;
      this.state.currentPage = 0;
      this.state.selected = null;
      this.state.pages = [];
      this.history.clear();

      this.dom.docTitleInput.value = fileName;
      this.dom.pageCountLabel.textContent = String(numPages);
      this.dom.pageNumberInput.value = '1';
      this.dom.pageNumberInput.max = String(numPages);

      // Habilita controles do documento
      ['btnPrevPage', 'btnNextPage', 'pageNumberInput', 'btnZoomOut', 'btnZoomIn', 'zoomSelect', 'btnRunOcr', 'btnOpenExport']
        .forEach(id => { document.getElementById(id).disabled = false; });

      // Extrai dimensões e textos de todas as páginas em paralelo controlado
      for (let i = 0; i < numPages; i++) {
        const meta = await this.pdfEngine.getPageMeta(i);
        const textRuns = await this.pdfEngine.extractTextRuns(i);
        this.state.pages.push({
          width: meta.width,
          height: meta.height,
          textRuns,
          objects: []
        });
      }

      // Se o PDF foi exportado anteriormente no modo "PDF Editável", restaura as camadas!
      if (embeddedProject && Array.isArray(embeddedProject.pages)) {
        embeddedProject.pages.forEach((savedPage, idx) => {
          if (!this.state.pages[idx]) return;
          if (Array.isArray(savedPage.objects)) {
            this.state.pages[idx].objects = savedPage.objects;
          }
          if (Array.isArray(savedPage.textRuns)) {
            for (const sr of savedPage.textRuns) {
              const match = this.state.pages[idx].textRuns.find(
                r => Math.abs(r.origX - sr.origX) < 3 && Math.abs(r.origY - sr.origY) < 3
              );
              if (match) Object.assign(match, sr, { id: match.id });
              else this.state.pages[idx].textRuns.push(sr);
            }
          }
        });
        Utils.toast('Projeto editável detectado e camadas restauradas!', 'success', 3800);
      }

      this.dom.welcomeScreen.hidden = true;
      this.dom.pagesContainer.hidden = false;

      // Calcula zoom inicial confortável ajustado à largura se a tela for menor
      const availW = this.dom.viewport.clientWidth - 72;
      const firstW = this.state.pages[0]?.width || 595;
      if (availW > 300 && firstW * 1.25 > availW) {
        this.state.zoom = Utils.clamp(Utils.round1(availW / firstW), 0.5, 2.0);
      } else {
        this.state.zoom = 1.25;
      }
      this.syncZoomSelect();

      this.buildPagesDOM();
      await this.renderAllPages();
      await this.renderThumbnails();

      this.pushHistory();
      this.updateSidebars();
      this.updateStatusBar();
      Utils.toast(`"${fileName}" carregado (${numPages} ${numPages === 1 ? 'página' : 'páginas'}).`, 'success');
    }

    buildPagesDOM() {
      this.dom.pagesContainer.innerHTML = '';
      this.pageElements = [];

      for (let i = 0; i < this.state.numPages; i++) {
        const pData = this.state.pages[i];
        const wrapper = document.createElement('div');
        wrapper.className = 'pdf-page-wrapper';
        wrapper.dataset.pageIndex = String(i);

        const tag = document.createElement('div');
        tag.className = 'pdf-page-header-tag';
        tag.textContent = `Página ${i + 1} de ${this.state.numPages}`;

        const pageBox = document.createElement('div');
        pageBox.className = 'pdf-page-container';
        pageBox.dataset.pageIndex = String(i);
        pageBox.style.width = `${pData.width * this.state.zoom}px`;
        pageBox.style.height = `${pData.height * this.state.zoom}px`;

        const canvas = document.createElement('canvas');
        canvas.className = 'page-canvas';

        const maskLayer = document.createElement('div');
        maskLayer.className = 'mask-layer';

        const textLayer = document.createElement('div');
        textLayer.className = 'text-overlay-layer';

        const drawingLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        drawingLayer.setAttribute('class', 'drawing-layer');

        const objectsLayer = document.createElement('div');
        objectsLayer.className = 'objects-layer';

        pageBox.append(canvas, maskLayer, textLayer, drawingLayer, objectsLayer);
        wrapper.append(tag, pageBox);
        this.dom.pagesContainer.appendChild(wrapper);

        this.bindPageInteractionEvents(pageBox, i);
        this.pageElements.push({ wrapper, pageBox, canvas, maskLayer, textLayer, drawingLayer, objectsLayer });
      }
    }

    async renderAllPages() {
      const gen = ++this.renderGeneration;
      for (let i = 0; i < this.state.numPages; i++) {
        if (gen !== this.renderGeneration) return;
        const pData = this.state.pages[i];
        const els = this.pageElements[i];
        if (!els) continue;

        els.pageBox.style.width = `${pData.width * this.state.zoom}px`;
        els.pageBox.style.height = `${pData.height * this.state.zoom}px`;

        await this.pdfEngine.renderPageToCanvas(i, els.canvas, this.state.zoom);
        if (gen !== this.renderGeneration) return;
        this.renderPageOverlays(i);
      }
    }

    async renderThumbnails() {
      this.dom.thumbnailsList.innerHTML = '';
      for (let i = 0; i < this.state.numPages; i++) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `thumb-item ${i === this.state.currentPage ? 'active' : ''}`;
        item.dataset.pageIndex = String(i);

        const cWrap = document.createElement('div');
        cWrap.className = 'thumb-canvas-wrap';
        const c = document.createElement('canvas');
        cWrap.appendChild(c);

        const label = document.createElement('span');
        label.className = 'thumb-label';
        label.textContent = `Página ${i + 1}`;

        item.append(cWrap, label);
        item.addEventListener('click', () => this.goToPage(i));
        this.dom.thumbnailsList.appendChild(item);

        // Renderiza em segundo plano sem travar a UI
        this.pdfEngine.renderThumbnail(i, c, 146).catch(() => {});
      }
    }

    /* ------------------------------------------------------------------------
       RENDERIZAÇÃO DAS CAMADAS EDITÁVEIS (TEXTO ORIGINAL + OBJETOS + MÁSCARAS)
       ------------------------------------------------------------------------ */
    renderPageOverlays(pageIndex) {
      const pData = this.state.pages[pageIndex];
      const els = this.pageElements[pageIndex];
      if (!pData || !els) return;

      const z = this.state.zoom;
      els.maskLayer.innerHTML = '';
      els.textLayer.innerHTML = '';
      els.objectsLayer.innerHTML = '';

      // 1. Camada de Máscaras + Textos Originais do PDF
      for (const run of pData.textRuns) {
        if (run.edited || run.moved || run.deleted) {
          const mask = document.createElement('div');
          mask.className = 'pdf-text-mask';
          mask.style.left = `${(run.origX - 1.5) * z}px`;
          mask.style.top = `${(run.origY - 1.5) * z}px`;
          mask.style.width = `${(run.origW + 3) * z}px`;
          mask.style.height = `${(run.origH + 3) * z}px`;
          mask.style.backgroundColor = run.maskColor || '#ffffff';
          els.maskLayer.appendChild(mask);
        }

        if (run.deleted) continue;

        const span = document.createElement('div');
        span.className = 'pdf-text-run';
        span.dataset.runId = run.id;
        span.dataset.pageIndex = String(pageIndex);

        const isSel = this.state.selected?.kind === 'textRun' && this.state.selected.id === run.id;
        if (run.edited || run.moved) span.classList.add('edited');
        if (isSel) span.classList.add('selected');

        span.style.left = `${run.x * z}px`;
        span.style.top = `${run.y * z}px`;
        span.style.minWidth = `${run.width * z}px`;
        span.style.minHeight = `${run.height * z}px`;
        if (run.edited || run.moved) {
          span.style.width = `${Math.max(run.width, 16) * z}px`;
        }
        span.style.fontFamily = run.fontFamily;
        span.style.fontSize = `${run.fontSize * z}px`;
        span.style.fontWeight = run.bold ? 'bold' : 'normal';
        span.style.fontStyle = run.italic ? 'italic' : 'normal';
        span.style.textDecoration = this.buildTextDecoration(run);
        span.style.textAlign = run.align || 'left';
        span.style.lineHeight = String(run.lineHeight || 1.15);
        span.style.opacity = String(run.opacity != null ? run.opacity : 1);
        if (run.rotation) {
          span.style.transform = `rotate(${run.rotation}deg)`;
        }

        // Preservação máxima: texto não editado permanece transparente sobre o canvas PDF.js!
        if (run.edited || run.moved) {
          span.style.color = run.color || '#111111';
        } else {
          span.style.color = 'transparent';
        }

        span.textContent = run.text;
        this.bindTextRunEvents(span, run, pageIndex);

        // Se selecionado (e não editando), exibe alças para mover/redimensionar/rotacionar texto original
        if (isSel && this.state.tool === 'select') {
          this.appendTransformHandles(span, run, 'textRun', pageIndex);
        }

        els.textLayer.appendChild(span);
      }

      // 2. Camada de Objetos, Anotações, Imagens, Assinaturas e Formulários
      const sortedObjs = [...pData.objects].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
      for (const obj of sortedObjs) {
        const node = this.createObjectDOM(obj, pageIndex, z);
        els.objectsLayer.appendChild(node);
      }
    }

    buildTextDecoration(item) {
      const dec = [];
      if (item.underline) dec.push('underline');
      if (item.strikethrough) dec.push('line-through');
      return dec.length ? dec.join(' ') : 'none';
    }

    bindTextRunEvents(el, run, pageIndex) {
      const activateInlineEdit = (e) => {
        e.stopPropagation();
        // Amostra cores exatas do canvas na primeira interação
        if (!run.colorSampled) {
          const sampled = this.pdfEngine.sampleRunColors(pageIndex, run.origX, run.origY, run.origW, run.origH);
          run.maskColor = sampled.bgHex;
          run.color = sampled.fgHex;
          run.colorSampled = true;
        }

        const wasEdited = run.edited;
        run.edited = true;
        this.selectElement({ kind: 'textRun', pageIndex, id: run.id }, false);

        // Garante máscara imediata sob o texto ao abrir edição inline
        if (!wasEdited) {
          const z = this.state.zoom;
          const els = this.pageElements[pageIndex];
          const mask = document.createElement('div');
          mask.className = 'pdf-text-mask';
          mask.style.left = `${(run.origX - 1.5) * z}px`;
          mask.style.top = `${(run.origY - 1.5) * z}px`;
          mask.style.width = `${(run.origW + 3) * z}px`;
          mask.style.height = `${(run.origH + 3) * z}px`;
          mask.style.backgroundColor = run.maskColor;
          els.maskLayer.appendChild(mask);
        }

        el.classList.add('edited', 'editing');
        el.style.color = run.color;
        el.style.width = `${Math.max(run.width, 20) * this.state.zoom}px`;
        el.contentEditable = 'true';
        el.focus();

        // Sincroniza barra de formatação com este texto
        this.syncFormatBarFromItem(run);
        this.updateInspector();
      };

      el.addEventListener('mousedown', (e) => {
        if (e.button === 2) {
          this.selectElement({ kind: 'textRun', pageIndex, id: run.id });
          return;
        }
        if (el.contentEditable === 'true') {
          e.stopPropagation();
          return;
        }

        if (this.state.tool === 'edit-text') {
          activateInlineEdit(e);
        } else if (this.state.tool === 'select') {
          e.stopPropagation();
          if (!run.colorSampled) {
            const sampled = this.pdfEngine.sampleRunColors(pageIndex, run.origX, run.origY, run.origW, run.origH);
            run.maskColor = sampled.bgHex;
            run.color = sampled.fgHex;
            run.colorSampled = true;
          }
          this.selectElement({ kind: 'textRun', pageIndex, id: run.id });
          this.startDragElement(e, run, 'textRun', pageIndex);
        }
      });

      el.addEventListener('dblclick', (e) => {
        if (this.state.tool === 'select' || this.state.tool === 'edit-text') {
          activateInlineEdit(e);
        }
      });

      el.addEventListener('input', () => {
        run.text = el.innerText.replace(/\r/g, '');
        run.edited = true;
        // Atualiza largura mínima se o usuário digitar mais texto
        const measuredW = el.scrollWidth / this.state.zoom;
        const measuredH = el.scrollHeight / this.state.zoom;
        if (measuredW > run.width) run.width = Utils.round1(measuredW);
        if (measuredH > run.height) run.height = Utils.round1(measuredH);
        this.updateStatusBar();
      });

      el.addEventListener('blur', () => {
        if (el.contentEditable === 'true') {
          el.contentEditable = 'false';
          el.classList.remove('editing');
          run.text = el.innerText.replace(/\r/g, '');
          this.pushHistory();
          this.renderPageOverlays(pageIndex);
          this.updateSidebars();
        }
      });
    }

    createObjectDOM(obj, pageIndex, z) {
      const el = document.createElement('div');
      el.className = `editor-obj obj-${obj.type}`;
      el.dataset.objId = obj.id;
      el.dataset.pageIndex = String(pageIndex);

      const isSel = this.state.selected?.kind === 'object' && this.state.selected.id === obj.id;
      if (isSel) el.classList.add('selected');

      el.style.left = `${obj.x * z}px`;
      el.style.top = `${obj.y * z}px`;
      el.style.width = `${obj.width * z}px`;
      el.style.height = `${obj.height * z}px`;
      el.style.zIndex = String(20 + (obj.zIndex || 0));
      el.style.opacity = String(obj.opacity != null ? obj.opacity : 1);
      if (obj.rotation) {
        el.style.transform = `rotate(${obj.rotation}deg)`;
      }

      if (obj.type === 'textbox') {
        const inner = document.createElement('div');
        inner.className = 'obj-textbox-content';
        inner.style.fontFamily = obj.fontFamily;
        inner.style.fontSize = `${obj.fontSize * z}px`;
        inner.style.color = obj.color || '#111111';
        inner.style.backgroundColor = obj.bgTransparent ? 'transparent' : (obj.bgColor || '#ffffff');
        inner.style.fontWeight = obj.bold ? 'bold' : 'normal';
        inner.style.fontStyle = obj.italic ? 'italic' : 'normal';
        inner.style.textDecoration = this.buildTextDecoration(obj);
        inner.style.textAlign = obj.align || 'left';
        inner.style.lineHeight = String(obj.lineHeight || 1.15);
        inner.textContent = obj.text;

        inner.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          el.classList.add('editing-text');
          inner.contentEditable = 'true';
          inner.focus();
        });
        inner.addEventListener('input', () => {
          obj.text = inner.innerText.replace(/\r/g, '');
          const h = inner.scrollHeight / this.state.zoom;
          if (h > obj.height) {
            obj.height = Utils.round1(h);
            el.style.height = `${obj.height * this.state.zoom}px`;
          }
        });
        inner.addEventListener('blur', () => {
          if (inner.contentEditable === 'true') {
            inner.contentEditable = 'false';
            el.classList.remove('editing-text');
            obj.text = inner.innerText.replace(/\r/g, '');
            this.pushHistory();
            this.updateSidebars();
          }
        });
        el.appendChild(inner);
      } else if (obj.type === 'highlight') {
        el.style.backgroundColor = obj.color || '#fde047';
      } else if (obj.type === 'image' || obj.type === 'signature') {
        const img = document.createElement('img');
        img.className = 'obj-img';
        img.src = obj.dataUrl;
        img.draggable = false;
        el.appendChild(img);
      } else if (obj.type === 'shape') {
        const svg = this.createShapeSVG(obj, z);
        el.appendChild(svg);
      } else if (obj.type === 'draw') {
        const svg = this.createDrawingSVG(obj, z);
        el.appendChild(svg);
      } else if (obj.type === 'comment') {
        const pin = document.createElement('div');
        pin.className = 'obj-comment-pin';
        pin.textContent = '!';
        pin.title = obj.text || 'Clique para abrir comentário';
        pin.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          obj.open = !obj.open;
          this.renderPageOverlays(pageIndex);
        });
        el.appendChild(pin);

        if (obj.open || isSel) {
          const pop = document.createElement('div');
          pop.className = 'comment-popover';
          pop.addEventListener('mousedown', (e) => e.stopPropagation());
          const head = document.createElement('div');
          head.className = 'comment-popover-head';
          head.innerHTML = `<span>${obj.author || 'Revisor'}</span><span>${obj.timestamp || ''}</span>`;
          const ta = document.createElement('textarea');
          ta.value = obj.text || '';
          ta.placeholder = 'Escreva seu comentário...';
          ta.addEventListener('input', () => {
            obj.text = ta.value;
            this.updateCommentsSidebar();
          });
          ta.addEventListener('change', () => this.pushHistory());
          pop.append(head, ta);
          el.appendChild(pop);
        }
      } else if (obj.type === 'form') {
        const wrap = document.createElement('div');
        wrap.className = 'obj-form-wrap';

        if (obj.formType === 'text') {
          const inp = document.createElement('input');
          inp.type = 'text';
          inp.className = 'form-widget-input';
          inp.value = obj.value || '';
          inp.placeholder = obj.fieldName || 'Campo de texto';
          inp.style.fontSize = `${Math.max(9, 11 * z)}px`;
          inp.addEventListener('mousedown', (e) => {
            if (isSel) e.stopPropagation();
          });
          inp.addEventListener('input', () => { obj.value = inp.value; this.updateInspector(); });
          inp.addEventListener('change', () => this.pushHistory());
          wrap.appendChild(inp);
        } else if (obj.formType === 'checkbox') {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.className = 'form-widget-check';
          cb.checked = !!obj.checked;
          cb.addEventListener('mousedown', (e) => e.stopPropagation());
          cb.addEventListener('change', () => {
            obj.checked = cb.checked;
            this.pushHistory();
            this.updateInspector();
          });
          wrap.appendChild(cb);
        } else if (obj.formType === 'radio') {
          const rb = document.createElement('input');
          rb.type = 'radio';
          rb.className = 'form-widget-radio';
          rb.name = `radio_${pageIndex}_${obj.radioGroup || 'grupo'}`;
          rb.checked = !!obj.checked;
          rb.addEventListener('mousedown', (e) => e.stopPropagation());
          rb.addEventListener('change', () => {
            // Desmarca outros radios do mesmo grupo
            this.state.pages[pageIndex].objects.forEach(o => {
              if (o.type === 'form' && o.formType === 'radio' && o.radioGroup === obj.radioGroup) {
                o.checked = (o.id === obj.id);
              }
            });
            this.pushHistory();
            this.renderPageOverlays(pageIndex);
            this.updateInspector();
          });
          wrap.appendChild(rb);
        } else if (obj.formType === 'dropdown') {
          const sel = document.createElement('select');
          sel.className = 'form-widget-select';
          sel.style.fontSize = `${Math.max(9, 11 * z)}px`;
          const opts = obj.options && obj.options.length ? obj.options : ['Opção 1', 'Opção 2', 'Opção 3'];
          opts.forEach(opt => {
            const o = document.createElement('option');
            o.value = opt;
            o.textContent = opt;
            if (opt === obj.value) o.selected = true;
            sel.appendChild(o);
          });
          sel.addEventListener('mousedown', (e) => { if (isSel) e.stopPropagation(); });
          sel.addEventListener('change', () => {
            obj.value = sel.value;
            this.pushHistory();
            this.updateInspector();
          });
          wrap.appendChild(sel);
        } else if (obj.formType === 'signature') {
          const box = document.createElement('div');
          box.className = 'form-widget-sigfield';
          if (obj.signatureDataUrl) {
            const img = document.createElement('img');
            img.src = obj.signatureDataUrl;
            box.appendChild(img);
          } else {
            box.innerHTML = '<span>✍ Campo de Assinatura</span><small>Duplo clique para assinar</small>';
          }
          box.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this.signatureManager.open(obj.id);
          });
          wrap.appendChild(box);
        }
        el.appendChild(wrap);
      }

      // Eventos de seleção, arrasto e menu de contexto
      el.addEventListener('mousedown', (e) => {
        if (e.button === 2) {
          this.selectElement({ kind: 'object', pageIndex, id: obj.id });
          return;
        }
        if (this.state.tool !== 'select') return;
        if (el.classList.contains('editing-text')) return;
        e.stopPropagation();
        this.selectElement({ kind: 'object', pageIndex, id: obj.id });
        this.startDragElement(e, obj, 'object', pageIndex);
      });

      if (isSel && this.state.tool === 'select') {
        this.appendTransformHandles(el, obj, 'object', pageIndex);
      }

      return el;
    }

    createShapeSVG(obj, z) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'obj-svg');
      const w = Math.max(2, obj.width * z);
      const h = Math.max(2, obj.height * z);
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

      const stroke = obj.strokeColor || '#2563eb';
      const sw = (obj.strokeWidth != null ? obj.strokeWidth : 2) * z;
      const fill = obj.fillTransparent ? 'none' : (obj.fillColor || '#3b82f6');

      if (obj.shapeType === 'rect') {
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r.setAttribute('x', sw / 2);
        r.setAttribute('y', sw / 2);
        r.setAttribute('width', Math.max(1, w - sw));
        r.setAttribute('height', Math.max(1, h - sw));
        r.setAttribute('stroke', stroke);
        r.setAttribute('stroke-width', sw);
        r.setAttribute('fill', fill);
        svg.appendChild(r);
      } else if (obj.shapeType === 'ellipse') {
        const ep = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
        ep.setAttribute('cx', w / 2);
        ep.setAttribute('cy', h / 2);
        ep.setAttribute('rx', Math.max(1, (w - sw) / 2));
        ep.setAttribute('ry', Math.max(1, (h - sw) / 2));
        ep.setAttribute('stroke', stroke);
        ep.setAttribute('stroke-width', sw);
        ep.setAttribute('fill', fill);
        svg.appendChild(ep);
      } else if (obj.shapeType === 'line' || obj.shapeType === 'arrow') {
        const cy = h / 2;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', '0');
        line.setAttribute('y1', cy);
        line.setAttribute('x2', w);
        line.setAttribute('y2', cy);
        line.setAttribute('stroke', stroke);
        line.setAttribute('stroke-width', Math.max(1.5, sw));
        line.setAttribute('stroke-linecap', 'round');
        svg.appendChild(line);

        if (obj.shapeType === 'arrow') {
          const hl = Math.max(8 * z, sw * 4);
          const head = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
          head.setAttribute('points', `${w - hl},${cy - hl * 0.55} ${w},${cy} ${w - hl},${cy + hl * 0.55}`);
          head.setAttribute('fill', 'none');
          head.setAttribute('stroke', stroke);
          head.setAttribute('stroke-width', Math.max(1.5, sw));
          head.setAttribute('stroke-linecap', 'round');
          head.setAttribute('stroke-linejoin', 'round');
          svg.appendChild(head);
        }
      }
      return svg;
    }

    createDrawingSVG(obj, z) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'obj-svg');
      const w = Math.max(2, obj.width * z);
      const h = Math.max(2, obj.height * z);
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

      if (obj.points && obj.points.length > 1) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        let d = `M ${(obj.points[0].x * w).toFixed(1)} ${(obj.points[0].y * h).toFixed(1)}`;
        for (let i = 1; i < obj.points.length - 1; i++) {
          const xc = ((obj.points[i].x + obj.points[i + 1].x) / 2) * w;
          const yc = ((obj.points[i].y + obj.points[i + 1].y) / 2) * h;
          d += ` Q ${(obj.points[i].x * w).toFixed(1)} ${(obj.points[i].y * h).toFixed(1)}, ${xc.toFixed(1)} ${yc.toFixed(1)}`;
        }
        const last = obj.points[obj.points.length - 1];
        d += ` L ${(last.x * w).toFixed(1)} ${(last.y * h).toFixed(1)}`;
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', obj.strokeColor || '#2563eb');
        path.setAttribute('stroke-width', (obj.strokeWidth || 2) * z);
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);
      }
      return svg;
    }

    /* ------------------------------------------------------------------------
       ALÇAS DE REDIMENSIONAMENTO, ARRASTO E ROTAÇÃO
       ------------------------------------------------------------------------ */
    appendTransformHandles(el, item, kind, pageIndex) {
      const dirs = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
      for (const dir of dirs) {
        const h = document.createElement('div');
        h.className = `transform-handle handle-${dir}`;
        h.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          this.startResizeElement(e, item, kind, pageIndex, dir);
        });
        el.appendChild(h);
      }

      const stem = document.createElement('div');
      stem.className = 'rotate-stem';
      const rot = document.createElement('div');
      rot.className = 'handle-rotate';
      rot.title = 'Arraste para rotacionar (Segure Shift para 15°)';
      rot.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        this.startRotateElement(e, item, kind, pageIndex, el);
      });
      el.append(stem, rot);
    }

    startDragElement(e, item, kind, pageIndex) {
      const startX = e.clientX;
      const startY = e.clientY;
      const origX = item.x;
      const origY = item.y;
      const z = this.state.zoom;
      let moved = false;

      const onMove = (ev) => {
        const dx = (ev.clientX - startX) / z;
        const dy = (ev.clientY - startY) / z;
        if (!moved && Math.hypot(dx, dy) < 2) return;
        moved = true;
        item.x = Utils.round1(origX + dx);
        item.y = Utils.round1(origY + dy);
        if (kind === 'textRun') item.moved = true;
        this.renderPageOverlays(pageIndex);
        this.updateInspector();
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (moved) {
          this.pushHistory();
          this.updateSidebars();
        }
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    startResizeElement(e, item, kind, pageIndex, dir) {
      const startX = e.clientX;
      const startY = e.clientY;
      const o = { x: item.x, y: item.y, w: item.width, h: item.height };
      const aspect = item.aspectRatio || (o.w / Math.max(o.h, 1));
      const lockAspect = (item.type === 'image' || item.type === 'signature') && (item.lockAspect !== false) && !e.shiftKey;
      const z = this.state.zoom;
      let changed = false;

      const onMove = (ev) => {
        const dx = (ev.clientX - startX) / z;
        const dy = (ev.clientY - startY) / z;
        changed = true;

        let nx = o.x, ny = o.y, nw = o.w, nh = o.h;
        if (dir.includes('e')) nw = Math.max(8, o.w + dx);
        if (dir.includes('s')) nh = Math.max(8, o.h + dy);
        if (dir.includes('w')) {
          nw = Math.max(8, o.w - dx);
          nx = o.x + (o.w - nw);
        }
        if (dir.includes('n')) {
          nh = Math.max(8, o.h - dy);
          ny = o.y + (o.h - nh);
        }

        if (lockAspect && (dir.length === 2)) {
          nh = Math.max(8, nw / aspect);
          if (dir.includes('n')) ny = o.y + (o.h - nh);
        }

        item.x = Utils.round1(nx);
        item.y = Utils.round1(ny);
        item.width = Utils.round1(nw);
        item.height = Utils.round1(nh);
        if (kind === 'textRun') item.moved = true;

        this.renderPageOverlays(pageIndex);
        this.updateInspector();
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (changed) {
          this.pushHistory();
          this.updateSidebars();
        }
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    startRotateElement(e, item, kind, pageIndex, el) {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let changed = false;

      const onMove = (ev) => {
        changed = true;
        let angle = Math.atan2(ev.clientY - cy, ev.clientX - cx) * (180 / Math.PI) + 90;
        if (ev.shiftKey) angle = Math.round(angle / 15) * 15;
        else angle = Math.round(angle);
        if (angle > 180) angle -= 360;
        if (angle < -180) angle += 360;
        item.rotation = angle;
        if (kind === 'textRun') item.moved = true;
        this.renderPageOverlays(pageIndex);
        this.updateInspector();
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (changed) this.pushHistory();
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    /* ------------------------------------------------------------------------
       INTERAÇÕES NA PÁGINA (CRIAÇÃO DE ANOTAÇÕES, FORMAS, DESENHO, FORMULÁRIOS)
       ------------------------------------------------------------------------ */
    bindPageInteractionEvents(pageBox, pageIndex) {
      pageBox.addEventListener('mousemove', (e) => {
        const rect = pageBox.getBoundingClientRect();
        const px = Utils.round1((e.clientX - rect.left) / this.state.zoom);
        const py = Utils.round1((e.clientY - rect.top) / this.state.zoom);
        this.dom.statusCoords.textContent = `X: ${px} pt · Y: ${py} pt`;
      });

      pageBox.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.openContextMenu(e.clientX, e.clientY);
      });

      pageBox.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        this.closeContextMenu();
        this.state.currentPage = pageIndex;
        this.syncCurrentPageUI();

        const rect = pageBox.getBoundingClientRect();
        const startPtX = (e.clientX - rect.left) / this.state.zoom;
        const startPtY = (e.clientY - rect.top) / this.state.zoom;

        if (this.state.tool === 'select') {
          if (e.target === pageBox || e.target.classList.contains('text-overlay-layer') || e.target.classList.contains('objects-layer')) {
            this.selectElement(null);
          }
          return;
        }

        if (this.state.tool === 'comment') {
          const obj = {
            id: Utils.uid('cmt'),
            type: 'comment',
            pageIndex,
            x: Utils.round1(startPtX - 13),
            y: Utils.round1(startPtY - 13),
            width: 26,
            height: 26,
            rotation: 0,
            opacity: 1,
            zIndex: ++this.state.zCounter,
            author: 'Revisor',
            text: '',
            timestamp: Utils.formatTimestamp(),
            open: true
          };
          this.state.pages[pageIndex].objects.push(obj);
          this.pushHistory();
          this.setTool('select');
          this.selectElement({ kind: 'object', pageIndex, id: obj.id });
          this.renderPageOverlays(pageIndex);
          this.updateSidebars();
          return;
        }

        if (this.state.tool === 'draw') {
          this.handleFreehandDraw(e, pageBox, pageIndex, startPtX, startPtY);
          return;
        }

        if (['textbox', 'highlight', 'shape', 'form'].includes(this.state.tool)) {
          this.handleBoxCreation(e, pageBox, pageIndex, startPtX, startPtY);
        }
      });
    }

    handleFreehandDraw(e, pageBox, pageIndex, startPtX, startPtY) {
      const z = this.state.zoom;
      const svg = this.pageElements[pageIndex].drawingLayer;
      const rawPoints = [{ x: startPtX, y: startPtY }];

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', this.state.format.strokeColor);
      path.setAttribute('stroke-width', String(this.state.format.strokeWidth * z));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.setAttribute('opacity', String(this.state.format.opacity));
      svg.appendChild(path);

      const updatePath = () => {
        let d = `M ${(rawPoints[0].x * z).toFixed(1)} ${(rawPoints[0].y * z).toFixed(1)}`;
        for (let i = 1; i < rawPoints.length; i++) {
          d += ` L ${(rawPoints[i].x * z).toFixed(1)} ${(rawPoints[i].y * z).toFixed(1)}`;
        }
        path.setAttribute('d', d);
      };

      const onMove = (ev) => {
        const rect = pageBox.getBoundingClientRect();
        const px = (ev.clientX - rect.left) / z;
        const py = (ev.clientY - rect.top) / z;
        const last = rawPoints[rawPoints.length - 1];
        if (Math.hypot(px - last.x, py - last.y) >= 1.5) {
          rawPoints.push({ x: px, y: py });
          updatePath();
        }
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        path.remove();

        if (rawPoints.length < 2) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        rawPoints.forEach(p => {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        });
        const w = Math.max(8, maxX - minX);
        const h = Math.max(8, maxY - minY);
        const normalized = rawPoints.map(p => ({
          x: (p.x - minX) / w,
          y: (p.y - minY) / h
        }));

        const obj = {
          id: Utils.uid('drw'),
          type: 'draw',
          pageIndex,
          x: Utils.round1(minX),
          y: Utils.round1(minY),
          width: Utils.round1(w),
          height: Utils.round1(h),
          rotation: 0,
          opacity: this.state.format.opacity,
          zIndex: ++this.state.zCounter,
          strokeColor: this.state.format.strokeColor,
          strokeWidth: this.state.format.strokeWidth,
          points: normalized
        };
        this.state.pages[pageIndex].objects.push(obj);
        this.pushHistory();
        this.renderPageOverlays(pageIndex);
        this.updateSidebars();
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    handleBoxCreation(e, pageBox, pageIndex, startPtX, startPtY) {
      const z = this.state.zoom;
      const preview = document.createElement('div');
      preview.className = 'creation-preview';
      preview.style.left = `${startPtX * z}px`;
      preview.style.top = `${startPtY * z}px`;
      preview.style.width = '1px';
      preview.style.height = '1px';
      pageBox.appendChild(preview);

      let curX = startPtX, curY = startPtY;

      const onMove = (ev) => {
        const rect = pageBox.getBoundingClientRect();
        curX = (ev.clientX - rect.left) / z;
        curY = (ev.clientY - rect.top) / z;
        const x = Math.min(startPtX, curX);
        const y = Math.min(startPtY, curY);
        const w = Math.abs(curX - startPtX);
        const h = Math.abs(curY - startPtY);
        preview.style.left = `${x * z}px`;
        preview.style.top = `${y * z}px`;
        preview.style.width = `${w * z}px`;
        preview.style.height = `${h * z}px`;
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        preview.remove();

        const x = Utils.round1(Math.min(startPtX, curX));
        const y = Utils.round1(Math.min(startPtY, curY));
        let w = Utils.round1(Math.abs(curX - startPtX));
        let h = Utils.round1(Math.abs(curY - startPtY));

        const tool = this.state.tool;
        const f = this.state.format;
        let obj = null;

        if (tool === 'textbox') {
          if (w < 24) w = 180;
          if (h < 18) h = 28;
          obj = {
            id: Utils.uid('txt'),
            type: 'textbox',
            pageIndex,
            x, y, width: w, height: h,
            rotation: 0,
            opacity: f.opacity,
            zIndex: ++this.state.zCounter,
            text: 'Digite o texto aqui',
            fontFamily: f.fontFamily,
            fontSize: f.fontSize,
            color: f.color,
            bgColor: f.bgColor,
            bgTransparent: f.bgTransparent,
            bold: f.bold,
            italic: f.italic,
            underline: f.underline,
            strikethrough: f.strikethrough,
            align: f.align,
            lineHeight: f.lineHeight
          };
        } else if (tool === 'highlight') {
          if (w < 8) w = 120;
          if (h < 6) h = 16;
          obj = {
            id: Utils.uid('hl'),
            type: 'highlight',
            pageIndex,
            x, y, width: w, height: h,
            rotation: 0,
            opacity: 0.5,
            zIndex: ++this.state.zCounter,
            color: f.highlightColor
          };
        } else if (tool === 'shape') {
          const isLine = this.state.shapeType === 'line' || this.state.shapeType === 'arrow';
          if (w < 10) w = 120;
          if (h < 8) h = isLine ? 22 : 70;
          obj = {
            id: Utils.uid('shp'),
            type: 'shape',
            shapeType: this.state.shapeType,
            pageIndex,
            x, y, width: w, height: h,
            rotation: 0,
            opacity: f.opacity,
            zIndex: ++this.state.zCounter,
            strokeColor: f.strokeColor,
            strokeWidth: f.strokeWidth,
            fillColor: f.bgColor,
            fillTransparent: f.bgTransparent
          };
        } else if (tool === 'form') {
          const ft = this.state.formType;
          const defaults = {
            text:      { w: 170, h: 24 },
            checkbox:  { w: 18,  h: 18 },
            radio:     { w: 18,  h: 18 },
            dropdown:  { w: 165, h: 24 },
            signature: { w: 185, h: 56 }
          };
          if (w < 12) w = defaults[ft].w;
          if (h < 12) h = defaults[ft].h;
          obj = {
            id: Utils.uid('frm'),
            type: 'form',
            formType: ft,
            pageIndex,
            x, y, width: w, height: h,
            rotation: 0,
            opacity: 1,
            zIndex: ++this.state.zCounter,
            fieldName: `campo_${ft}_${this.state.zCounter}`,
            value: ft === 'dropdown' ? 'Opção 1' : '',
            checked: false,
            radioGroup: 'grupo_1',
            options: ['Opção 1', 'Opção 2', 'Opção 3'],
            required: false,
            signatureDataUrl: null
          };
        }

        if (!obj) return;
        this.state.pages[pageIndex].objects.push(obj);
        this.pushHistory();
        if (tool !== 'highlight') this.setTool('select');
        this.selectElement({ kind: 'object', pageIndex, id: obj.id });
        this.renderPageOverlays(pageIndex);
        this.updateSidebars();

        // Se acabou de criar uma caixa de texto, já abre em edição direta
        if (obj.type === 'textbox') {
          const el = this.pageElements[pageIndex].objectsLayer.querySelector(`[data-obj-id="${obj.id}"]`);
          const inner = el?.querySelector('.obj-textbox-content');
          if (inner) {
            el.classList.add('editing-text');
            inner.contentEditable = 'true';
            inner.focus();
            document.execCommand('selectAll', false, null);
          }
        }
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    insertImageOrSignature(dataUrl, type = 'image') {
      if (!this.state.numPages) {
        Utils.toast('Abra ou crie um PDF antes de inserir imagens ou assinaturas.', 'warning');
        return;
      }
      const pageIndex = this.state.currentPage;
      const pData = this.state.pages[pageIndex];
      const img = new Image();
      img.onload = () => {
        const natW = img.naturalWidth || 240;
        const natH = img.naturalHeight || 120;
        const maxW = type === 'signature' ? 180 : Math.min(260, pData.width * 0.45);
        const ratio = natW / Math.max(natH, 1);
        const w = Utils.round1(Math.min(maxW, natW));
        const h = Utils.round1(w / ratio);

        const obj = {
          id: Utils.uid(type === 'signature' ? 'sig' : 'img'),
          type,
          pageIndex,
          x: Utils.round1((pData.width - w) / 2),
          y: Utils.round1((pData.height - h) / 2),
          width: w,
          height: h,
          rotation: 0,
          opacity: 1,
          zIndex: ++this.state.zCounter,
          dataUrl,
          lockAspect: true,
          aspectRatio: ratio
        };
        pData.objects.push(obj);
        this.pushHistory();
        this.setTool('select');
        this.selectElement({ kind: 'object', pageIndex, id: obj.id });
        this.renderPageOverlays(pageIndex);
        this.updateSidebars();
        Utils.toast(type === 'signature' ? 'Assinatura inserida! Arraste para posicionar.' : 'Imagem inserida na página!', 'success');
      };
      img.src = dataUrl;
    }

    /* ------------------------------------------------------------------------
       SELEÇÃO, INSPETOR, FORMATAÇÃO, CLIPBOARD E HISTÓRICO
       ------------------------------------------------------------------------ */
    getSelectedItem() {
      const sel = this.state.selected;
      if (!sel) return null;
      const pData = this.state.pages[sel.pageIndex];
      if (!pData) return null;
      if (sel.kind === 'object') {
        const obj = pData.objects.find(o => o.id === sel.id);
        return obj ? { item: obj, kind: 'object', pageIndex: sel.pageIndex } : null;
      }
      const run = pData.textRuns.find(r => r.id === sel.id);
      return run ? { item: run, kind: 'textRun', pageIndex: sel.pageIndex } : null;
    }

    findObjectById(id) {
      for (let i = 0; i < this.state.pages.length; i++) {
        const obj = this.state.pages[i].objects.find(o => o.id === id);
        if (obj) return { obj, pageIndex: i };
      }
      return null;
    }

    selectElement(sel, rerender = true) {
      const prev = this.state.selected;
      this.state.selected = sel;

      if (rerender) {
        if (prev && this.state.pages[prev.pageIndex]) this.renderPageOverlays(prev.pageIndex);
        if (sel && sel.pageIndex !== prev?.pageIndex && this.state.pages[sel.pageIndex]) {
          this.renderPageOverlays(sel.pageIndex);
        }
      }

      const info = this.getSelectedItem();
      if (info && (info.kind === 'textRun' || info.item.type === 'textbox')) {
        this.syncFormatBarFromItem(info.item);
      }
      this.updateInspector();
      this.updateSidebars();
    }

    syncFormatBarFromItem(item) {
      if (!item) return;
      const f = this.state.format;
      f.fontFamily = item.fontFamily || f.fontFamily;
      f.fontSize = item.fontSize || f.fontSize;
      f.color = item.color || f.color;
      f.bold = !!item.bold;
      f.italic = !!item.italic;
      f.underline = !!item.underline;
      f.strikethrough = !!item.strikethrough;
      f.align = item.align || 'left';
      f.lineHeight = item.lineHeight || 1.15;
      if (item.bgColor) f.bgColor = item.bgColor;
      if (item.bgTransparent != null) f.bgTransparent = item.bgTransparent;

      document.getElementById('fmtFontFamily').value = f.fontFamily;
      document.getElementById('fmtFontSize').value = f.fontSize;
      document.getElementById('fmtTextColor').value = f.color;
      document.getElementById('fmtBgColor').value = f.bgColor;
      document.getElementById('fmtBgTransparent').classList.toggle('active', f.bgTransparent);
      document.getElementById('fmtBold').classList.toggle('active', f.bold);
      document.getElementById('fmtItalic').classList.toggle('active', f.italic);
      document.getElementById('fmtUnderline').classList.toggle('active', f.underline);
      document.getElementById('fmtStrike').classList.toggle('active', f.strikethrough);
      document.getElementById('fmtLineHeight').value = String(f.lineHeight);
      document.querySelectorAll('.align-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.align === f.align);
      });
    }

    applyFormatChange(patch) {
      Object.assign(this.state.format, patch);
      const info = this.getSelectedItem();
      if (!info) return;

      const { item, kind, pageIndex } = info;
      if (kind === 'textRun') {
        if (!item.colorSampled) {
          const sampled = this.pdfEngine.sampleRunColors(pageIndex, item.origX, item.origY, item.origW, item.origH);
          item.maskColor = sampled.bgHex;
          item.colorSampled = true;
        }
        Object.assign(item, patch);
        item.edited = true;
        this.pushHistory();
        this.renderPageOverlays(pageIndex);
      } else if (item.type === 'textbox') {
        Object.assign(item, patch);
        this.pushHistory();
        this.renderPageOverlays(pageIndex);
      } else if (item.type === 'shape' || item.type === 'draw') {
        if (patch.strokeColor != null) item.strokeColor = patch.strokeColor;
        if (patch.strokeWidth != null) item.strokeWidth = patch.strokeWidth;
        if (patch.bgColor != null) item.fillColor = patch.bgColor;
        if (patch.bgTransparent != null) item.fillTransparent = patch.bgTransparent;
        if (patch.opacity != null) item.opacity = patch.opacity;
        this.pushHistory();
        this.renderPageOverlays(pageIndex);
      } else if (item.type === 'highlight') {
        if (patch.highlightColor != null) item.color = patch.highlightColor;
        if (patch.opacity != null) item.opacity = patch.opacity;
        this.pushHistory();
        this.renderPageOverlays(pageIndex);
      }
      this.updateInspector();
    }

    updateInspector() {
      const info = this.getSelectedItem();
      if (!info) {
        this.dom.inspectorEmpty.hidden = false;
        this.dom.inspectorContent.hidden = true;
        this.dom.selectedTypeBadge.textContent = 'Nenhum';
        this.dom.selectedTypeBadge.classList.add('muted');
        return;
      }

      const { item, kind } = info;
      this.dom.inspectorEmpty.hidden = true;
      this.dom.inspectorContent.hidden = false;
      this.dom.selectedTypeBadge.classList.remove('muted');

      const typeNames = {
        textRun: 'Texto do PDF',
        textbox: 'Caixa de Texto',
        highlight: 'Destaque',
        comment: 'Comentário',
        draw: 'Desenho Livre',
        shape: 'Forma',
        image: 'Imagem',
        signature: 'Assinatura',
        form: 'Formulário'
      };
      this.dom.selectedTypeBadge.textContent = kind === 'textRun' ? typeNames.textRun : (typeNames[item.type] || 'Objeto');

      document.getElementById('propX').value = Utils.round1(item.x);
      document.getElementById('propY').value = Utils.round1(item.y);
      document.getElementById('propW').value = Utils.round1(item.width);
      document.getElementById('propH').value = Utils.round1(item.height);
      document.getElementById('propRotation').value = Math.round(item.rotation || 0);
      document.getElementById('propOpacity').value = Math.round((item.opacity != null ? item.opacity : 1) * 100);

      // Grupos condicionais
      document.getElementById('propOriginalTextGroup').hidden = (kind !== 'textRun');
      if (kind === 'textRun') {
        document.getElementById('propMaskColor').value = item.maskColor || '#ffffff';
      }

      const isVector = kind === 'object' && (item.type === 'shape' || item.type === 'draw');
      document.getElementById('propShapeGroup').hidden = !isVector;
      if (isVector) {
        document.getElementById('propStrokeColor').value = item.strokeColor || '#2563eb';
        document.getElementById('propStrokeWidth').value = item.strokeWidth != null ? item.strokeWidth : 2;
        document.getElementById('propFillColor').value = item.fillColor || '#3b82f6';
        document.getElementById('propFillTransparent').checked = item.fillTransparent !== false;
      }

      const isImg = kind === 'object' && (item.type === 'image' || item.type === 'signature');
      document.getElementById('propImageGroup').hidden = !isImg;
      if (isImg) {
        document.getElementById('propLockAspect').checked = item.lockAspect !== false;
      }

      const isComment = kind === 'object' && item.type === 'comment';
      document.getElementById('propCommentGroup').hidden = !isComment;
      if (isComment) {
        document.getElementById('propCommentAuthor').value = item.author || 'Revisor';
        document.getElementById('propCommentText').value = item.text || '';
      }

      const isForm = kind === 'object' && item.type === 'form';
      document.getElementById('propFormGroup').hidden = !isForm;
      if (isForm) {
        document.getElementById('propFormName').value = item.fieldName || '';
        document.getElementById('propFormRequired').checked = !!item.required;
        document.getElementById('propFormValueWrap').hidden = !['text', 'radio'].includes(item.formType);
        document.getElementById('propFormValue').value = item.value || '';
        document.getElementById('propFormGroupWrap').hidden = (item.formType !== 'radio');
        document.getElementById('propFormRadioGroup').value = item.radioGroup || 'grupo_1';
        document.getElementById('propFormOptionsWrap').hidden = (item.formType !== 'dropdown');
        document.getElementById('propFormOptions').value = (item.options || []).join('\n');
        document.getElementById('propFormCheckedWrap').hidden = !['checkbox', 'radio'].includes(item.formType);
        document.getElementById('propFormChecked').checked = !!item.checked;
      }
    }

    updateSidebars() {
      this.updateLayersSidebar();
      this.updateCommentsSidebar();
      this.updateStatusBar();
    }

    updateLayersSidebar() {
      const pData = this.state.pages[this.state.currentPage];
      this.dom.layersList.innerHTML = '';
      if (!pData) return;

      const items = [];
      pData.textRuns.forEach(r => {
        if (r.edited || r.moved || r.deleted) {
          items.push({ kind: 'textRun', item: r, title: r.deleted ? `(Excluído) ${r.origText}` : r.text, meta: 'Texto original editado' });
        }
      });
      pData.objects.forEach(o => {
        const titles = {
          textbox: o.text || 'Caixa de texto',
          highlight: 'Destaque de texto',
          comment: o.text || 'Comentário',
          draw: 'Desenho à mão livre',
          shape: `Forma (${o.shapeType})`,
          image: 'Imagem inserida',
          signature: 'Assinatura digital',
          form: `Campo: ${o.fieldName || o.formType}`
        };
        items.push({ kind: 'object', item: o, title: titles[o.type] || o.type, meta: o.type });
      });

      this.dom.layersCountBadge.textContent = String(items.length);
      if (!items.length) {
        this.dom.layersList.innerHTML = '<div class="empty-hint">Nenhum objeto ou edição nesta página.</div>';
        return;
      }

      items.reverse().forEach(entry => {
        const row = document.createElement('div');
        const isSel = this.state.selected?.id === entry.item.id;
        row.className = `layer-row ${isSel ? 'selected' : ''}`;
        row.innerHTML = `
          <div class="layer-row-info">
            <div class="layer-row-title"></div>
            <div class="layer-row-meta">${entry.meta}</div>
          </div>
        `;
        row.querySelector('.layer-row-title').textContent = entry.title.slice(0, 42);
        row.addEventListener('click', () => {
          this.setTool('select');
          this.selectElement({ kind: entry.kind, pageIndex: this.state.currentPage, id: entry.item.id });
        });
        this.dom.layersList.appendChild(row);
      });
    }

    updateCommentsSidebar() {
      this.dom.commentsList.innerHTML = '';
      const allComments = [];
      this.state.pages.forEach((p, pIdx) => {
        p.objects.forEach(o => {
          if (o.type === 'comment') allComments.push({ obj: o, pageIndex: pIdx });
        });
      });

      this.dom.commentsCountBadge.textContent = String(allComments.length);
      if (!allComments.length) {
        this.dom.commentsList.innerHTML = '<div class="empty-hint">Use a ferramenta Comentário para adicionar notas ao documento.</div>';
        return;
      }

      allComments.forEach(({ obj, pageIndex }) => {
        const row = document.createElement('div');
        row.className = `comment-row ${this.state.selected?.id === obj.id ? 'selected' : ''}`;
        row.innerHTML = `
          <div class="comment-row-head">
            <strong>${obj.author || 'Revisor'} · Pág. ${pageIndex + 1}</strong>
            <span>${obj.timestamp || ''}</span>
          </div>
          <div class="comment-row-body"></div>
        `;
        row.querySelector('.comment-row-body').textContent = obj.text || '(Sem texto — clique para editar)';
        row.addEventListener('click', () => {
          this.goToPage(pageIndex);
          obj.open = true;
          this.setTool('select');
          this.selectElement({ kind: 'object', pageIndex, id: obj.id });
        });
        this.dom.commentsList.appendChild(row);
      });
    }

    updateStatusBar() {
      let edits = 0;
      this.state.pages.forEach(p => {
        edits += p.objects.length;
        edits += p.textRuns.filter(r => r.edited || r.moved || r.deleted).length;
      });
      this.dom.statusEditCount.textContent = `${edits} ${edits === 1 ? 'edição' : 'edições'}`;

      const curPage = this.state.pages[this.state.currentPage];
      if (curPage) {
        const wMm = Math.round(curPage.width * 0.352778);
        const hMm = Math.round(curPage.height * 0.352778);
        this.dom.statusPageSize.textContent = `${Math.round(curPage.width)}×${Math.round(curPage.height)} pt (${wMm}×${hMm} mm)`;
      }
      document.getElementById('btnUndo').disabled = !this.history.canUndo();
      document.getElementById('btnRedo').disabled = !this.history.canRedo();
    }

    /* ------------------------------------------------------------------------
       AÇÕES DE EDIÇÃO: DUPLICAR, COPIAR, RECORTAR, COLAR, EXCLUIR, Z-ORDER
       ------------------------------------------------------------------------ */
    deleteSelected() {
      const info = this.getSelectedItem();
      if (!info) return;
      const { item, kind, pageIndex } = info;
      const pData = this.state.pages[pageIndex];

      if (kind === 'object') {
        pData.objects = pData.objects.filter(o => o.id !== item.id);
      } else {
        if (!item.colorSampled) {
          const sampled = this.pdfEngine.sampleRunColors(pageIndex, item.origX, item.origY, item.origW, item.origH);
          item.maskColor = sampled.bgHex;
          item.colorSampled = true;
        }
        item.deleted = true;
      }

      this.state.selected = null;
      this.pushHistory();
      this.renderPageOverlays(pageIndex);
      this.updateInspector();
      this.updateSidebars();
    }

    duplicateSelected() {
      const info = this.getSelectedItem();
      if (!info) return;
      const { item, kind, pageIndex } = info;
      const pData = this.state.pages[pageIndex];

      let clone;
      if (kind === 'object') {
        clone = Utils.deepClone(item);
        clone.id = Utils.uid(clone.type);
        clone.x = Utils.round1(clone.x + 14);
        clone.y = Utils.round1(clone.y + 14);
        clone.zIndex = ++this.state.zCounter;
      } else {
        // Duplicar um texto original cria uma nova caixa de texto com a mesma tipografia exata
        clone = {
          id: Utils.uid('txt'),
          type: 'textbox',
          pageIndex,
          x: Utils.round1(item.x + 14),
          y: Utils.round1(item.y + 14),
          width: item.width,
          height: item.height,
          rotation: item.rotation || 0,
          opacity: item.opacity != null ? item.opacity : 1,
          zIndex: ++this.state.zCounter,
          text: item.text,
          fontFamily: item.fontFamily,
          fontSize: item.fontSize,
          color: item.color || '#111111',
          bgColor: '#ffffff',
          bgTransparent: true,
          bold: item.bold,
          italic: item.italic,
          underline: item.underline,
          strikethrough: item.strikethrough,
          align: item.align || 'left',
          lineHeight: item.lineHeight || 1.15
        };
      }

      pData.objects.push(clone);
      this.pushHistory();
      this.selectElement({ kind: 'object', pageIndex, id: clone.id });
      this.renderPageOverlays(pageIndex);
      this.updateSidebars();
    }

    copySelected() {
      if (this.isTypingInText()) {
        document.execCommand('copy');
        return;
      }
      const info = this.getSelectedItem();
      if (!info) return;
      const { item, kind } = info;
      if (kind === 'object') {
        this.state.clipboard = Utils.deepClone(item);
      } else {
        this.state.clipboard = {
          type: 'textbox',
          x: item.x, y: item.y, width: item.width, height: item.height,
          rotation: item.rotation || 0, opacity: 1,
          text: item.text, fontFamily: item.fontFamily, fontSize: item.fontSize,
          color: item.color || '#111111', bgColor: '#ffffff', bgTransparent: true,
          bold: item.bold, italic: item.italic, underline: item.underline,
          strikethrough: item.strikethrough, align: item.align || 'left', lineHeight: item.lineHeight || 1.15
        };
      }
      Utils.toast('Elemento copiado para a área de transferência.', 'info', 1600);
    }

    cutSelected() {
      if (this.isTypingInText()) {
        document.execCommand('cut');
        return;
      }
      if (!this.getSelectedItem()) return;
      this.copySelected();
      this.deleteSelected();
    }

    pasteClipboard() {
      if (this.isTypingInText()) {
        navigator.clipboard?.readText().then(t => document.execCommand('insertText', false, t)).catch(() => {});
        return;
      }
      if (!this.state.clipboard || !this.state.numPages) return;
      const pageIndex = this.state.currentPage;
      const clone = Utils.deepClone(this.state.clipboard);
      clone.id = Utils.uid(clone.type || 'obj');
      clone.pageIndex = pageIndex;
      clone.x = Utils.round1((clone.x || 40) + 16);
      clone.y = Utils.round1((clone.y || 40) + 16);
      clone.zIndex = ++this.state.zCounter;

      this.state.pages[pageIndex].objects.push(clone);
      this.state.clipboard.x = clone.x;
      this.state.clipboard.y = clone.y;

      this.pushHistory();
      this.setTool('select');
      this.selectElement({ kind: 'object', pageIndex, id: clone.id });
      this.renderPageOverlays(pageIndex);
      this.updateSidebars();
    }

    changeZOrder(direction) {
      const info = this.getSelectedItem();
      if (!info || info.kind !== 'object') return;
      const objs = this.state.pages[info.pageIndex].objects;
      if (direction === 'front') {
        const maxZ = objs.reduce((m, o) => Math.max(m, o.zIndex || 0), 0);
        info.item.zIndex = maxZ + 1;
        this.state.zCounter = Math.max(this.state.zCounter, info.item.zIndex);
      } else {
        const minZ = objs.reduce((m, o) => Math.min(m, o.zIndex || 0), 0);
        info.item.zIndex = minZ - 1;
      }
      this.pushHistory();
      this.renderPageOverlays(info.pageIndex);
    }

    /* ------------------------------------------------------------------------
       SNAPSHOTS DE HISTÓRICO (UNDO / REDO)
       ------------------------------------------------------------------------ */
    captureSnapshot() {
      return this.state.pages.map(p => ({
        textRuns: p.textRuns.map(r => ({
          id: r.id, x: r.x, y: r.y, width: r.width, height: r.height,
          rotation: r.rotation, opacity: r.opacity, text: r.text,
          fontFamily: r.fontFamily, fontSize: r.fontSize, color: r.color, maskColor: r.maskColor,
          colorSampled: r.colorSampled, bold: r.bold, italic: r.italic,
          underline: r.underline, strikethrough: r.strikethrough,
          align: r.align, lineHeight: r.lineHeight,
          edited: r.edited, moved: r.moved, deleted: r.deleted
        })),
        objects: Utils.deepClone(p.objects)
      }));
    }

    restoreSnapshot(snap) {
      if (!snap) return;
      snap.forEach((pSnap, idx) => {
        const pData = this.state.pages[idx];
        if (!pData) return;
        pData.objects = Utils.deepClone(pSnap.objects);
        const map = new Map(pSnap.textRuns.map(r => [r.id, r]));
        pData.textRuns.forEach(r => {
          const saved = map.get(r.id);
          if (saved) Object.assign(r, saved);
        });
        this.renderPageOverlays(idx);
      });
      this.state.selected = null;
      this.updateInspector();
      this.updateSidebars();
    }

    pushHistory() {
      this.history.push(this.captureSnapshot());
      this.updateStatusBar();
    }

    undo() {
      const snap = this.history.undo();
      if (snap) {
        this.restoreSnapshot(snap);
        Utils.toast('Ação desfeita.', 'info', 1300);
      }
    }

    redo() {
      const snap = this.history.redo();
      if (snap) {
        this.restoreSnapshot(snap);
        Utils.toast('Ação refeita.', 'info', 1300);
      }
    }

    /* ------------------------------------------------------------------------
       NAVEGAÇÃO, ZOOM E FERRAMENTAS
       ------------------------------------------------------------------------ */
    setTool(toolName) {
      this.state.tool = toolName;
      this.updateToolUI();
    }

    updateToolUI() {
      document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tool === this.state.tool);
      });

      const app = document.getElementById('app');
      Object.keys(TOOL_META).forEach(t => app.classList.remove(`tool-${t}`));
      app.classList.add(`tool-${this.state.tool}`);

      const meta = TOOL_META[this.state.tool] || TOOL_META.select;
      this.dom.statusToolBadge.textContent = `Ferramenta: ${meta.label}`;
      this.dom.statusHint.textContent = meta.hint;

      // Atualiza overlays na página atual para mostrar/ocultar alças conforme ferramenta
      if (this.state.selected) {
        this.renderPageOverlays(this.state.selected.pageIndex);
      }
    }

    goToPage(pageIndex) {
      if (!this.state.numPages) return;
      const idx = Utils.clamp(pageIndex, 0, this.state.numPages - 1);
      this.state.currentPage = idx;
      this.syncCurrentPageUI();
      const target = this.pageElements[idx]?.wrapper;
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      this.updateSidebars();
    }

    syncCurrentPageUI() {
      this.dom.pageNumberInput.value = String(this.state.currentPage + 1);
      document.getElementById('btnPrevPage').disabled = this.state.currentPage <= 0;
      document.getElementById('btnNextPage').disabled = this.state.currentPage >= this.state.numPages - 1;
      this.dom.thumbnailsList.querySelectorAll('.thumb-item').forEach((el, i) => {
        el.classList.toggle('active', i === this.state.currentPage);
      });
      this.updateStatusBar();
    }

    async setZoom(newZoom) {
      if (!this.state.numPages) return;
      this.state.zoom = Utils.clamp(Math.round(newZoom * 100) / 100, 0.35, 3.5);
      this.syncZoomSelect();
      await this.renderAllPages();
    }

    syncZoomSelect() {
      const sel = this.dom.zoomSelect;
      const match = [...sel.options].find(o => parseFloat(o.value) === this.state.zoom);
      if (match) {
        sel.value = match.value;
      } else {
        // Atualiza ou cria opção dinâmica para zoom customizado
        let custom = sel.querySelector('option[data-custom="1"]');
        if (!custom) {
          custom = document.createElement('option');
          custom.dataset.custom = '1';
          sel.insertBefore(custom, sel.firstChild);
        }
        custom.value = String(this.state.zoom);
        custom.textContent = `${Math.round(this.state.zoom * 100)}%`;
        sel.value = custom.value;
      }
    }

    /* ------------------------------------------------------------------------
       MENU DE CONTEXTO E VERIFICAÇÕES
       ------------------------------------------------------------------------ */
    openContextMenu(x, y) {
      const menu = this.dom.contextMenu;
      menu.hidden = false;
      const mw = menu.offsetWidth || 195;
      const mh = menu.offsetHeight || 220;
      menu.style.left = `${Math.min(x, window.innerWidth - mw - 8)}px`;
      menu.style.top = `${Math.min(y, window.innerHeight - mh - 8)}px`;
    }

    closeContextMenu() {
      this.dom.contextMenu.hidden = true;
    }

    isTypingInText() {
      const active = document.activeElement;
      if (!active) return false;
      const tag = active.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable;
    }

    /* ------------------------------------------------------------------------
       EXPORTAÇÃO & OCR
       ------------------------------------------------------------------------ */
    openExportModal() {
      if (!this.state.numPages) return;
      const baseName = (this.dom.docTitleInput.value.trim() || 'documento').replace(/\.pdf$/i, '');
      document.getElementById('exportFileName').value = `${baseName}-editado.pdf`;
      document.getElementById('exportProgressWrap').hidden = true;
      document.getElementById('exportModal').hidden = false;
    }

    async runExport() {
      const mode = document.querySelector('input[name="exportMode"]:checked')?.value || 'preserve';
      const flattenStrategy = document.getElementById('finalFlattenStrategy').value;
      let fileName = document.getElementById('exportFileName').value.trim() || 'documento-editado.pdf';
      if (!fileName.toLowerCase().endsWith('.pdf')) fileName += '.pdf';

      const progWrap = document.getElementById('exportProgressWrap');
      const progFill = document.getElementById('exportProgressFill');
      const progText = document.getElementById('exportProgressText');
      const btn = document.getElementById('btnConfirmExport');

      progWrap.hidden = false;
      btn.disabled = true;

      const onProgress = (pct, msg) => {
        progFill.style.width = `${pct}%`;
        progText.textContent = msg;
      };

      try {
        let pdfBytes;
        if (mode === 'preserve') {
          pdfBytes = await this.exporter.exportVectorPdf(this.state.pages, { editable: false, flattenForms: false, onProgress });
        } else if (mode === 'editable') {
          pdfBytes = await this.exporter.exportVectorPdf(this.state.pages, { editable: true, flattenForms: false, onProgress });
        } else {
          if (flattenStrategy === 'vector-flatten') {
            pdfBytes = await this.exporter.exportVectorPdf(this.state.pages, { editable: false, flattenForms: true, onProgress });
          } else {
            pdfBytes = await this.exporter.exportHighDpiFlattenedPdf(this.state.pages, { onProgress });
          }
        }

        onProgress(100, 'Download iniciado!');
        const blob = new Blob([pdfBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);

        document.getElementById('exportModal').hidden = true;
        Utils.toast(`PDF exportado com sucesso: ${fileName}`, 'success', 3800);
      } catch (err) {
        console.error(err);
        Utils.toast(`Erro na exportação: ${err.message}`, 'error', 5000);
      } finally {
        btn.disabled = false;
      }
    }

    async runOcr() {
      const lang = document.getElementById('ocrLang').value;
      const scope = document.getElementById('ocrScope').value;
      const progWrap = document.getElementById('ocrProgressWrap');
      const progFill = document.getElementById('ocrProgressFill');
      const progText = document.getElementById('ocrProgressText');
      const btn = document.getElementById('btnStartOcr');

      progWrap.hidden = false;
      btn.disabled = true;

      const pagesToScan = scope === 'all'
        ? Array.from({ length: this.state.numPages }, (_, i) => i)
        : [this.state.currentPage];

      try {
        let totalFound = 0;
        for (let i = 0; i < pagesToScan.length; i++) {
          const pIdx = pagesToScan[i];
          progText.textContent = `Analisando página ${pIdx + 1} (${i + 1}/${pagesToScan.length})...`;
          const runs = await OCRManager.recognizePage(this.pdfEngine, pIdx, lang, (pct) => {
            const overall = Math.round(((i + pct / 100) / pagesToScan.length) * 100);
            progFill.style.width = `${overall}%`;
            progText.textContent = `OCR Página ${pIdx + 1}: ${pct}%`;
          });
          this.state.pages[pIdx].textRuns.push(...runs);
          totalFound += runs.length;
          this.renderPageOverlays(pIdx);
        }

        this.pushHistory();
        this.setTool('edit-text');
        document.getElementById('ocrModal').hidden = true;
        Utils.toast(`OCR concluído! ${totalFound} linhas de texto detectadas e prontas para edição.`, 'success', 4200);
      } catch (err) {
        console.error(err);
        Utils.toast(`Erro no OCR: ${err.message}`, 'error', 5000);
      } finally {
        btn.disabled = false;
      }
    }

    /* ------------------------------------------------------------------------
       VINCULAÇÃO DE TODOS OS EVENTOS DE INTERFACE E ATALHOS
       ------------------------------------------------------------------------ */
    bindGlobalEvents() {
      // Abrir PDF / Exemplo / Branco
      document.getElementById('btnOpenPdf').addEventListener('click', () => this.dom.pdfFileInput.click());
      document.getElementById('btnWelcomeOpen').addEventListener('click', () => this.dom.pdfFileInput.click());
      this.dom.pdfFileInput.addEventListener('change', (e) => {
        if (e.target.files[0]) this.openPdfFile(e.target.files[0]);
        e.target.value = '';
      });

      document.getElementById('btnCreateSample').addEventListener('click', async () => {
        const bytes = await SamplePDFGenerator.createDemoPdf();
        await this.loadPdfBytes(bytes, 'Relatorio-Demonstracao.pdf');
      });

      document.getElementById('btnCreateBlank').addEventListener('click', async () => {
        const bytes = await SamplePDFGenerator.createBlankPdf();
        await this.loadPdfBytes(bytes, 'Novo-Documento.pdf');
      });

      // Drag and Drop global de PDF
      let dragDepth = 0;
      window.addEventListener('dragenter', (e) => {
        if (e.dataTransfer?.types?.includes('Files')) {
          dragDepth++;
          if (this.state.numPages) this.dom.dropOverlay.hidden = false;
          else this.dom.welcomeDropzone.classList.add('drag-over');
        }
      });
      window.addEventListener('dragover', (e) => e.preventDefault());
      window.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
          this.dom.dropOverlay.hidden = true;
          this.dom.welcomeDropzone.classList.remove('drag-over');
        }
      });
      window.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        this.dom.dropOverlay.hidden = true;
        this.dom.welcomeDropzone.classList.remove('drag-over');
        const file = e.dataTransfer?.files?.[0];
        if (file) this.openPdfFile(file);
      });

      // Painéis laterais e Tema
      document.getElementById('btnToggleLeftSidebar').addEventListener('click', () => {
        this.dom.leftSidebar.classList.toggle('collapsed');
      });
      document.getElementById('btnToggleRightPanel').addEventListener('click', () => {
        this.dom.rightSidebar.classList.toggle('collapsed');
      });
      document.getElementById('btnToggleTheme').addEventListener('click', () => {
        const html = document.documentElement;
        html.dataset.theme = html.dataset.theme === 'dark' ? 'light' : 'dark';
      });

      // Abas do painel lateral esquerdo
      document.querySelectorAll('.sidebar-tab').forEach(tab => {
        tab.addEventListener('click', () => {
          document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t === tab));
          const target = tab.dataset.tab;
          document.getElementById('tabThumbnails').classList.toggle('active', target === 'thumbnails');
          document.getElementById('tabLayers').classList.toggle('active', target === 'layers');
          document.getElementById('tabComments').classList.toggle('active', target === 'comments');
        });
      });

      // Histórico e Clipboard
      document.getElementById('btnUndo').addEventListener('click', () => this.undo());
      document.getElementById('btnRedo').addEventListener('click', () => this.redo());
      document.getElementById('btnCopy').addEventListener('click', () => this.copySelected());
      document.getElementById('btnCut').addEventListener('click', () => this.cutSelected());
      document.getElementById('btnPaste').addEventListener('click', () => this.pasteClipboard());
      document.getElementById('btnDuplicate').addEventListener('click', () => this.duplicateSelected());
      document.getElementById('btnDeleteSelected').addEventListener('click', () => this.deleteSelected());

      // Navegação de Páginas
      document.getElementById('btnPrevPage').addEventListener('click', () => this.goToPage(this.state.currentPage - 1));
      document.getElementById('btnNextPage').addEventListener('click', () => this.goToPage(this.state.currentPage + 1));
      this.dom.pageNumberInput.addEventListener('change', () => {
        const val = parseInt(this.dom.pageNumberInput.value, 10);
        if (!isNaN(val)) this.goToPage(val - 1);
      });

      // Atualiza página atual ao rolar o viewport
      this.dom.viewport.addEventListener('scroll', () => {
        if (!this.state.numPages) return;
        const vpRect = this.dom.viewport.getBoundingClientRect();
        const centerY = vpRect.top + vpRect.height * 0.35;
        let closest = this.state.currentPage;
        let bestDist = Infinity;
        this.pageElements.forEach((els, idx) => {
          const r = els.pageBox.getBoundingClientRect();
          const dist = Math.abs((r.top + r.bottom) / 2 - centerY);
          if (dist < bestDist) { bestDist = dist; closest = idx; }
        });
        if (closest !== this.state.currentPage) {
          this.state.currentPage = closest;
          this.syncCurrentPageUI();
          this.updateLayersSidebar();
        }
      });

      // Zoom
      document.getElementById('btnZoomOut').addEventListener('click', () => this.setZoom(this.state.zoom - 0.15));
      document.getElementById('btnZoomIn').addEventListener('click', () => this.setZoom(this.state.zoom + 0.15));
      this.dom.zoomSelect.addEventListener('change', () => {
        const v = this.dom.zoomSelect.value;
        const p = this.state.pages[this.state.currentPage];
        if (!p) return;
        if (v === 'fit-width') {
          this.setZoom((this.dom.viewport.clientWidth - 76) / p.width);
        } else if (v === 'fit-page') {
          const zw = (this.dom.viewport.clientWidth - 76) / p.width;
          const zh = (this.dom.viewport.clientHeight - 76) / p.height;
          this.setZoom(Math.min(zw, zh));
        } else {
          this.setZoom(parseFloat(v));
        }
      });

      // Ctrl + Scroll para Zoom suave
      this.dom.viewport.addEventListener('wheel', (e) => {
        if (e.ctrlKey && this.state.numPages) {
          e.preventDefault();
          const delta = e.deltaY < 0 ? 0.12 : -0.12;
          this.setZoom(this.state.zoom + delta);
        }
      }, { passive: false });

      // Botões de Ferramenta
      const closeDropdowns = () => {
        document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.remove('open'));
      };

      const positionDropdown = (btn, menu) => {
        const r = btn.getBoundingClientRect();
        menu.style.left = `${Math.min(r.left, window.innerWidth - 210)}px`;
        menu.style.top = `${r.bottom + 4}px`;
      };

      document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const tool = btn.dataset.tool;

          if (tool === 'shape') {
            const dd = document.getElementById('shapeDropdown');
            const wasOpen = dd.classList.contains('open');
            closeDropdowns();
            if (!wasOpen) { positionDropdown(btn, dd); dd.classList.add('open'); }
            this.setTool('shape');
            return;
          }

          if (tool === 'form') {
            const dd = document.getElementById('formDropdown');
            const wasOpen = dd.classList.contains('open');
            closeDropdowns();
            if (!wasOpen) { positionDropdown(btn, dd); dd.classList.add('open'); }
            this.setTool('form');
            return;
          }

          closeDropdowns();

          if (tool === 'image') {
            if (!this.state.numPages) {
              Utils.toast('Carregue um PDF primeiro para inserir uma imagem.', 'warning');
              return;
            }
            this.dom.imageFileInput.click();
            return;
          }

          if (tool === 'signature') {
            if (!this.state.numPages) {
              Utils.toast('Carregue um PDF primeiro para inserir sua assinatura.', 'warning');
              return;
            }
            this.signatureManager.open();
            return;
          }

          this.setTool(tool);
        });
      });

      document.querySelectorAll('#shapeDropdown .dropdown-item').forEach(item => {
        item.addEventListener('click', () => {
          this.state.shapeType = item.dataset.shape;
          document.querySelectorAll('#shapeDropdown .dropdown-item').forEach(i => i.classList.toggle('active', i === item));
          closeDropdowns();
          this.setTool('shape');
          Utils.toast(`Forma selecionada: ${item.textContent}`, 'info', 1400);
        });
      });

      document.querySelectorAll('#formDropdown .dropdown-item').forEach(item => {
        item.addEventListener('click', () => {
          this.state.formType = item.dataset.formType;
          document.querySelectorAll('#formDropdown .dropdown-item').forEach(i => i.classList.toggle('active', i === item));
          closeDropdowns();
          this.setTool('form');
          Utils.toast(`Campo selecionado: ${item.textContent}`, 'info', 1400);
        });
      });

      window.addEventListener('click', () => {
        closeDropdowns();
        this.closeContextMenu();
      });

      // Upload de imagem
      this.dom.imageFileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => this.insertImageOrSignature(reader.result, 'image');
        reader.readAsDataURL(file);
        e.target.value = '';
      });

      // Controles de Formatação de Texto na Ribbon
      document.getElementById('fmtFontFamily').addEventListener('change', (e) => this.applyFormatChange({ fontFamily: e.target.value }));
      document.getElementById('fmtFontSize').addEventListener('change', (e) => {
        const v = Utils.clamp(parseFloat(e.target.value) || 12, 5, 144);
        e.target.value = v;
        this.applyFormatChange({ fontSize: v });
      });
      document.getElementById('fmtTextColor').addEventListener('input', (e) => this.applyFormatChange({ color: e.target.value }));
      document.getElementById('fmtBgColor').addEventListener('input', (e) => {
        document.getElementById('fmtBgTransparent').classList.remove('active');
        this.applyFormatChange({ bgColor: e.target.value, bgTransparent: false });
      });
      document.getElementById('fmtBgTransparent').addEventListener('click', (e) => {
        const next = !this.state.format.bgTransparent;
        e.currentTarget.classList.toggle('active', next);
        this.applyFormatChange({ bgTransparent: next });
      });

      document.getElementById('fmtBold').addEventListener('click', (e) => {
        const next = !this.state.format.bold;
        e.currentTarget.classList.toggle('active', next);
        this.applyFormatChange({ bold: next });
      });
      document.getElementById('fmtItalic').addEventListener('click', (e) => {
        const next = !this.state.format.italic;
        e.currentTarget.classList.toggle('active', next);
        this.applyFormatChange({ italic: next });
      });
      document.getElementById('fmtUnderline').addEventListener('click', (e) => {
        const next = !this.state.format.underline;
        e.currentTarget.classList.toggle('active', next);
        this.applyFormatChange({ underline: next });
      });
      document.getElementById('fmtStrike').addEventListener('click', (e) => {
        const next = !this.state.format.strikethrough;
        e.currentTarget.classList.toggle('active', next);
        this.applyFormatChange({ strikethrough: next });
      });

      document.querySelectorAll('.align-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('.align-btn').forEach(b => b.classList.toggle('active', b === btn));
          this.applyFormatChange({ align: btn.dataset.align });
        });
      });

      document.getElementById('fmtLineHeight').addEventListener('change', (e) => {
        this.applyFormatChange({ lineHeight: parseFloat(e.target.value) || 1.15 });
      });

      // Controles de Traço, Destaque e Opacidade
      document.getElementById('styleStrokeColor').addEventListener('input', (e) => {
        this.applyFormatChange({ strokeColor: e.target.value });
      });
      document.getElementById('styleStrokeWidth').addEventListener('change', (e) => {
        this.applyFormatChange({ strokeWidth: Utils.clamp(parseFloat(e.target.value) || 2, 0, 40) });
      });
      document.getElementById('styleHighlightColor').addEventListener('input', (e) => {
        this.applyFormatChange({ highlightColor: e.target.value });
      });
      document.getElementById('styleOpacity').addEventListener('input', (e) => {
        const pct = parseInt(e.target.value, 10);
        document.getElementById('styleOpacityVal').textContent = `${pct}%`;
        this.applyFormatChange({ opacity: pct / 100 });
      });

      // Inspetor de Propriedades (Painel Direito)
      const bindPropInput = (id, handler) => {
        document.getElementById(id).addEventListener('change', (e) => {
          const info = this.getSelectedItem();
          if (!info) return;
          handler(info, e.target);
          this.pushHistory();
          this.renderPageOverlays(info.pageIndex);
          this.updateSidebars();
        });
      };

      bindPropInput('propX', (info, el) => { info.item.x = parseFloat(el.value) || 0; if (info.kind === 'textRun') info.item.moved = true; });
      bindPropInput('propY', (info, el) => { info.item.y = parseFloat(el.value) || 0; if (info.kind === 'textRun') info.item.moved = true; });
      bindPropInput('propW', (info, el) => { info.item.width = Math.max(4, parseFloat(el.value) || 20); if (info.kind === 'textRun') info.item.moved = true; });
      bindPropInput('propH', (info, el) => { info.item.height = Math.max(4, parseFloat(el.value) || 20); if (info.kind === 'textRun') info.item.moved = true; });
      bindPropInput('propRotation', (info, el) => { info.item.rotation = parseFloat(el.value) || 0; if (info.kind === 'textRun') info.item.moved = true; });
      bindPropInput('propOpacity', (info, el) => { info.item.opacity = Utils.clamp((parseFloat(el.value) || 100) / 100, 0.05, 1); });

      bindPropInput('propMaskColor', (info, el) => { info.item.maskColor = el.value; info.item.edited = true; });
      document.getElementById('btnAutoMaskColor').addEventListener('click', () => {
        const info = this.getSelectedItem();
        if (!info || info.kind !== 'textRun') return;
        const sampled = this.pdfEngine.sampleRunColors(info.pageIndex, info.item.origX, info.item.origY, info.item.origW, info.item.origH);
        info.item.maskColor = sampled.bgHex;
        document.getElementById('propMaskColor').value = sampled.bgHex;
        this.pushHistory();
        this.renderPageOverlays(info.pageIndex);
      });

      document.getElementById('btnRestoreOriginalText').addEventListener('click', () => {
        const info = this.getSelectedItem();
        if (!info || info.kind !== 'textRun') return;
        const r = info.item;
        r.x = r.origX; r.y = r.origY; r.width = r.origW; r.height = r.origH;
        r.text = r.origText; r.fontFamily = r.origFontFamily; r.fontSize = r.origFontSize;
        r.bold = r.origBold; r.italic = r.origItalic; r.underline = false; r.strikethrough = false;
        r.rotation = 0; r.opacity = 1; r.edited = false; r.moved = false; r.deleted = false;
        this.pushHistory();
        this.renderPageOverlays(info.pageIndex);
        this.updateInspector();
        this.updateSidebars();
        Utils.toast('Texto original do PDF restaurado com fidelidade.', 'success');
      });

      bindPropInput('propStrokeColor', (info, el) => { info.item.strokeColor = el.value; });
      bindPropInput('propStrokeWidth', (info, el) => { info.item.strokeWidth = Math.max(0, parseFloat(el.value) || 0); });
      bindPropInput('propFillColor', (info, el) => { info.item.fillColor = el.value; info.item.fillTransparent = false; document.getElementById('propFillTransparent').checked = false; });
      bindPropInput('propFillTransparent', (info, el) => { info.item.fillTransparent = el.checked; });
      bindPropInput('propLockAspect', (info, el) => { info.item.lockAspect = el.checked; });

      bindPropInput('propCommentAuthor', (info, el) => { info.item.author = el.value; });
      bindPropInput('propCommentText', (info, el) => { info.item.text = el.value; });

      bindPropInput('propFormName', (info, el) => { info.item.fieldName = el.value; });
      bindPropInput('propFormValue', (info, el) => { info.item.value = el.value; });
      bindPropInput('propFormRadioGroup', (info, el) => { info.item.radioGroup = el.value; });
      bindPropInput('propFormOptions', (info, el) => {
        info.item.options = el.value.split('\n').map(s => s.trim()).filter(Boolean);
        if (!info.item.options.length) info.item.options = ['Opção 1'];
      });
      bindPropInput('propFormChecked', (info, el) => { info.item.checked = el.checked; });
      bindPropInput('propFormRequired', (info, el) => { info.item.required = el.checked; });

      document.getElementById('btnPropDuplicate').addEventListener('click', () => this.duplicateSelected());
      document.getElementById('btnPropBringFront').addEventListener('click', () => this.changeZOrder('front'));
      document.getElementById('btnPropSendBack').addEventListener('click', () => this.changeZOrder('back'));
      document.getElementById('btnPropDelete').addEventListener('click', () => this.deleteSelected());

      // Menu de Contexto
      this.dom.contextMenu.querySelectorAll('.ctx-item').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const act = btn.dataset.ctx;
          this.closeContextMenu();
          if (act === 'edit') {
            const info = this.getSelectedItem();
            if (info?.kind === 'textRun') {
              const el = this.pageElements[info.pageIndex].textLayer.querySelector(`[data-run-id="${info.item.id}"]`);
              el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            } else if (info?.item?.type === 'textbox') {
              const el = this.pageElements[info.pageIndex].objectsLayer.querySelector(`[data-obj-id="${info.item.id}"] .obj-textbox-content`);
              el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            }
          } else if (act === 'copy') this.copySelected();
          else if (act === 'cut') this.cutSelected();
          else if (act === 'paste') this.pasteClipboard();
          else if (act === 'duplicate') this.duplicateSelected();
          else if (act === 'front') this.changeZOrder('front');
          else if (act === 'back') this.changeZOrder('back');
          else if (act === 'delete') this.deleteSelected();
        });
      });

      // Modais (Exportar, OCR, Assinatura)
      document.querySelectorAll('[data-close-modal]').forEach(btn => {
        btn.addEventListener('click', () => {
          document.getElementById(btn.dataset.closeModal).hidden = true;
        });
      });

      document.getElementById('btnOpenExport').addEventListener('click', () => this.openExportModal());
      document.getElementById('btnConfirmExport').addEventListener('click', () => this.runExport());

      document.querySelectorAll('input[name="exportMode"]').forEach(radio => {
        radio.addEventListener('change', () => {
          document.querySelectorAll('.export-card').forEach(c => c.classList.remove('selected'));
          radio.closest('.export-card')?.classList.add('selected');
          document.getElementById('finalQualityWrap').hidden = (radio.value !== 'final');
        });
      });

      document.getElementById('btnRunOcr').addEventListener('click', () => {
        if (!this.state.numPages) return;
        document.getElementById('ocrProgressWrap').hidden = true;
        document.getElementById('ocrModal').hidden = false;
      });
      document.getElementById('btnStartOcr').addEventListener('click', () => this.runOcr());

      // Atalhos de Teclado Globais
      window.addEventListener('keydown', (e) => {
        const ctrl = e.ctrlKey || e.metaKey;
        const typing = this.isTypingInText();

        if (e.key === 'Escape') {
          this.closeContextMenu();
          ['signatureModal', 'exportModal', 'ocrModal'].forEach(id => {
            document.getElementById(id).hidden = true;
          });
          if (!typing) this.selectElement(null);
          return;
        }

        if (ctrl && e.key.toLowerCase() === 'o') {
          e.preventDefault();
          this.dom.pdfFileInput.click();
          return;
        }
        if (ctrl && e.key.toLowerCase() === 's') {
          e.preventDefault();
          this.openExportModal();
          return;
        }
        if (ctrl && e.key.toLowerCase() === 'z' && !typing) {
          e.preventDefault();
          if (e.shiftKey) this.redo(); else this.undo();
          return;
        }
        if (ctrl && e.key.toLowerCase() === 'y' && !typing) {
          e.preventDefault();
          this.redo();
          return;
        }
        if (ctrl && e.key.toLowerCase() === 'd' && !typing) {
          e.preventDefault();
          this.duplicateSelected();
          return;
        }
        if (ctrl && e.key.toLowerCase() === 'c' && !typing) {
          e.preventDefault();
          this.copySelected();
          return;
        }
        if (ctrl && e.key.toLowerCase() === 'x' && !typing) {
          e.preventDefault();
          this.cutSelected();
          return;
        }
        if (ctrl && e.key.toLowerCase() === 'v' && !typing) {
          e.preventDefault();
          this.pasteClipboard();
          return;
        }

        // Atalhos de formatação (B / I / U) quando objeto texto está selecionado
        if (ctrl && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
          const info = this.getSelectedItem();
          if (info && (info.kind === 'textRun' || info.item.type === 'textbox')) {
            e.preventDefault();
            if (e.key.toLowerCase() === 'b') document.getElementById('fmtBold').click();
            if (e.key.toLowerCase() === 'i') document.getElementById('fmtItalic').click();
            if (e.key.toLowerCase() === 'u') document.getElementById('fmtUnderline').click();
            return;
          }
        }

        if (typing) return;

        // Teclas de exclusão e movimentação fina com setas
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (this.getSelectedItem()) {
            e.preventDefault();
            this.deleteSelected();
          }
          return;
        }

        const arrowStep = e.shiftKey ? 10 : 1;
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
          const info = this.getSelectedItem();
          if (info) {
            e.preventDefault();
            if (e.key === 'ArrowUp') info.item.y -= arrowStep;
            if (e.key === 'ArrowDown') info.item.y += arrowStep;
            if (e.key === 'ArrowLeft') info.item.x -= arrowStep;
            if (e.key === 'ArrowRight') info.item.x += arrowStep;
            if (info.kind === 'textRun') info.item.moved = true;
            this.pushHistory();
            this.renderPageOverlays(info.pageIndex);
            this.updateInspector();
            return;
          }
        }

        if (e.key === 'PageUp') { e.preventDefault(); this.goToPage(this.state.currentPage - 1); return; }
        if (e.key === 'PageDown') { e.preventDefault(); this.goToPage(this.state.currentPage + 1); return; }

        // Atalhos de ferramentas (letra única)
        const keyMap = { v: 'select', t: 'edit-text', x: 'textbox', h: 'highlight', c: 'comment', d: 'draw', s: 'shape' };
        const mapped = keyMap[e.key.toLowerCase()];
        if (mapped) {
          this.setTool(mapped);
        }
      });
    }
  }

  // Inicialização segura quando o DOM estiver pronto
  window.addEventListener('DOMContentLoaded', () => {
    window.pdfEditorApp = new PDFEditorApp();
  });
})();
