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
  // Cópia do PDF sem as edições: é a base usada ao reabrir um PDF editável
  const ORIGINAL_ATTACHMENT_NAME = 'pdf-studio-pro-original.pdf';
  const PDF_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const OBJECT_TYPES = ['textbox', 'highlight', 'comment', 'draw', 'shape', 'image', 'signature', 'form'];

  const TOOL_META = {
    select:     { label: 'Mover',          line: 'move',   hint: 'Toque num item para selecionar e arraste para mover.' },
    'edit-text':{ label: 'Corrigir texto', line: 'text',   hint: 'Toque num texto do documento para reescrever.' },
    textbox:    { label: 'Escrever',       line: 'mark',   hint: 'Toque ou arraste na página para criar um texto.' },
    highlight:  { label: 'Destacar',       line: 'insert', hint: 'Arraste sobre o trecho que quer marcar.' },
    comment:    { label: 'Comentar',       line: 'insert', hint: 'Toque no ponto da página para deixar uma nota.' },
    draw:       { label: 'Desenhar',       line: 'insert', hint: 'Desenhe direto na página. Dois dedos rolam e ampliam.' },
    shape:      { label: 'Forma',          line: 'insert', hint: 'Arraste na página para desenhar a forma.' },
    image:      { label: 'Imagem',         line: 'insert', hint: 'Escolha uma imagem para colocar na página.' },
    signature:  { label: 'Assinar',        line: 'sign',   hint: 'Crie sua assinatura e arraste até o lugar certo.' },
    form:       { label: 'Campo',          line: 'mark',   hint: 'Toque ou arraste na página para criar o campo.' }
  };

  // Celular e telas de toque baixas: mesma condição usada na folha de estilos
  const COMPACT = window.matchMedia('(max-width: 860px), (max-height: 520px) and (pointer: coarse)');

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

    /**
     * Retângulo alinhado aos eixos que envolve uma caixa girada em torno do centro.
     */
    rotatedBounds(x, y, width, height, deg = 0) {
      const rad = (deg * Math.PI) / 180;
      const w = Math.abs(width * Math.cos(rad)) + Math.abs(height * Math.sin(rad));
      const h = Math.abs(width * Math.sin(rad)) + Math.abs(height * Math.cos(rad));
      return { x: x + (width - w) / 2, y: y + (height - h) / 2, width: w, height: h };
    },

    /** Campos de formulário em PDF só podem girar em múltiplos de 90°. */
    snapRightAngle(deg = 0) {
      return Math.round((deg || 0) / 90) * 90;
    },

    /**
     * Valida o projeto embutido no PDF: o arquivo pode vir de qualquer pessoa.
     */
    sanitizeProject(project) {
      if (!project || !Array.isArray(project.pages)) return null;
      const list = (v) => (Array.isArray(v) ? v : []);
      const hasNumbers = (o, keys) => keys.every(k => Number.isFinite(o[k]));
      const safeId = (id) => (typeof id === 'string' && /^[\w-]+$/.test(id) ? id : Utils.uid('obj'));
      const safeImage = (v) => (typeof v === 'string' && v.startsWith('data:image/') ? v : null);
      const box = ['x', 'y', 'width', 'height'];

      return {
        pages: project.pages.map((page, pageIndex) => ({
          textRuns: list(page?.textRuns)
            .filter(r => r && typeof r.text === 'string' && hasNumbers(r, [...box, 'origX', 'origY', 'origW', 'origH']))
            .map(r => ({ ...r, pageIndex, id: safeId(r.id) })),
          objects: list(page?.objects)
            .filter(o => o && OBJECT_TYPES.includes(o.type) && hasNumbers(o, box))
            .map(o => ({
              ...o,
              pageIndex,
              id: safeId(o.id),
              dataUrl: safeImage(o.dataUrl),
              signatureDataUrl: safeImage(o.signatureDataUrl),
              points: list(o.points).filter(p => p && hasNumbers(p, ['x', 'y'])),
              options: list(o.options).map(String)
            }))
        }))
      };
    },

    /**
     * Texto que já existia no PDF é uma linha só: a fonte substituta pode ser um
     * pouco mais larga, e isso não deve quebrá-lo. Só quebra se a caixa for estreitada.
     */
    keepsSingleLine(item) {
      return item.origW !== undefined && item.width >= item.origW;
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
      // O processamento do PDF roda em um Web Worker, fora da thread da interface
      if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
      }
      this.pdfDoc = null;
      this.originalBytes = null;
      this.pageCanvases = new Map(); // pageIndex -> { canvas, scale }
      this.renderTasks = new Map(); // canvas -> renderização em andamento
    }

    openDocument(bytes) {
      return window.pdfjsLib.getDocument({
        data: bytes.slice(), // passa cópia para preservar os bytes intactos
        cMapPacked: true
      }).promise;
    }

    async loadFromBytes(uint8Array) {
      let bytes = new Uint8Array(uint8Array);
      let pdfDoc = await this.openDocument(bytes);

      // Verifica se existe projeto editável embutido anteriormente por este editor
      let embeddedProject = null;
      let exportedBytes = null;
      let legacyProject = false;
      try {
        const attachments = await pdfDoc.getAttachments();
        const projectFile = attachments?.[PROJECT_ATTACHMENT_NAME];
        if (projectFile) {
          const originalFile = attachments[ORIGINAL_ATTACHMENT_NAME];
          if (originalFile) {
            const decoded = new TextDecoder('utf-8').decode(projectFile.content);
            const project = Utils.sanitizeProject(JSON.parse(decoded));
            if (project) {
              // Reabre sobre o PDF sem edições, para não desenhar tudo duas vezes
              const originalBytes = new Uint8Array(originalFile.content);
              pdfDoc = await this.openDocument(originalBytes);
              exportedBytes = bytes;
              bytes = originalBytes;
              embeddedProject = project;
            }
          } else {
            legacyProject = true;
          }
        }
      } catch (err) {
        console.warn('Sem projeto embutido restaurável:', err);
      }

      this.originalBytes = bytes;
      this.pdfDoc = pdfDoc;
      this.pageCanvases.clear();

      return {
        numPages: pdfDoc.numPages,
        embeddedProject,
        exportedBytes,
        legacyProject
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
      // Limita a resolução para não estourar a memória do canvas no celular
      const base = page.getViewport({ scale: zoomScale });
      const maxDpr = Math.sqrt(12e6 / (base.width * base.height));
      const dpr = Math.min(window.devicePixelRatio || 1, COMPACT.matches ? 2 : 2.5, maxDpr);
      const cssViewport = page.getViewport({ scale: zoomScale });
      const renderViewport = page.getViewport({ scale: zoomScale * dpr });

      // O PDF.js não aceita duas renderizações no mesmo canvas: cancela a anterior
      while (this.renderTasks.has(canvas)) {
        const running = this.renderTasks.get(canvas);
        running.cancel();
        await running.promise.catch(() => {});
        if (this.renderTasks.get(canvas) === running) this.renderTasks.delete(canvas);
      }

      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      canvas.style.width = `${cssViewport.width}px`;
      canvas.style.height = `${cssViewport.height}px`;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const task = page.render({ canvasContext: ctx, viewport: renderViewport });
      this.renderTasks.set(canvas, task);
      try {
        await task.promise;
      } catch (err) {
        if (err?.name === 'RenderingCancelledException') return null;
        throw err;
      } finally {
        if (this.renderTasks.get(canvas) === task) this.renderTasks.delete(canvas);
      }
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
      // O texto só traz um apelido da fonte (g_d0_f1); o nome real, que indica
      // negrito e itálico, fica disponível depois de ler os operadores da página
      await page.getOperatorList();
      const realFontName = (id) => (page.commonObjs.has(id) ? page.commonObjs.get(id)?.name || id : id);

      const rawItems = [];
      for (const item of textContent.items) {
        if (!item.str || !item.str.trim()) continue;

        const tx = window.pdfjsLib.Util.transform(viewport.transform, item.transform);
        const fontHeight = Math.hypot(tx[2], tx[3]) || Math.abs(item.height) || 12;
        const angleRad = Math.atan2(tx[1], tx[0]);
        const angleDeg = Math.round((angleRad * 180) / Math.PI);

        // Coordenadas em pontos PDF (origem topo-esquerda). A caixa é guardada
        // "deitada" e girada em torno do próprio centro, como na tela.
        const rotation = Math.abs(angleDeg) < 2 ? 0 : angleDeg;
        const rad = (rotation * Math.PI) / 180;
        const baselineY = tx[5];
        const height = fontHeight * 1.18;
        const width = Math.max(item.width || (item.str.length * fontHeight * 0.52), 4);
        const centerX = tx[4] + Math.cos(rad) * width / 2 + Math.sin(rad) * fontHeight * 0.29;
        const centerY = baselineY + Math.sin(rad) * width / 2 - Math.cos(rad) * fontHeight * 0.29;
        const x = centerX - width / 2;
        const y = centerY - height / 2;

        const fontStyle = Utils.parsePdfFont(realFontName(item.fontName), styles[item.fontName]);

        rawItems.push({
          str: item.str,
          x,
          y,
          baselineY,
          width,
          height,
          fontSize: Utils.round1(fontHeight),
          rotation,
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
          cur.rotation === 0 &&
          prev.rotation === 0;

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
        origRotation: m.rotation,
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

    /** Libera a memória de uma página que saiu da tela. */
    releasePage(pageIndex, canvas) {
      this.renderTasks.get(canvas)?.cancel();
      this.pageCanvases.delete(pageIndex);
      canvas.width = 0;
      canvas.height = 0;
    }

    /** Amostra as cores na área que o texto original ocupa na página. */
    sampleColorsForRun(pageIndex, run) {
      const b = Utils.rotatedBounds(run.origX, run.origY, run.origW, run.origH, run.origRotation);
      return this.sampleRunColors(pageIndex, b.x, b.y, b.width, b.height);
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
        x: 42, y: height - 52, size: 16, font: fontBold, color: rgb(1, 1, 1)
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
        ['Integração de Assinatura e PDF', '01', 'R$ 4.200,00', 'R$ 4.200,00'],
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
      p1.drawText('- Na página 2 há uma área dedicada para assinatura e preenchimento cadastral.', { x: 56, y: 148, size: 9.5, font: fontReg, color: rgb(0.32, 0.25, 0.1) });

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
        const density = this.canvas.width / (this.canvas.clientWidth || this.canvas.width);
        this.ctx.lineWidth = (parseFloat(document.getElementById('sigInkWidth').value) || 2.5) * density;
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
      this.fitCanvas();
      this.renderSavedList();
    }

    close() {
      this.modal.hidden = true;
    }

    /** Ajusta a área de desenho ao tamanho real na tela, para o traço não distorcer. */
    fitCanvas() {
      const w = Math.round(this.canvas.clientWidth * 2);
      const h = Math.round(this.canvas.clientHeight * 2);
      if (!w || !h || (this.canvas.width === w && this.canvas.height === h)) return;
      this.canvas.width = w;
      this.canvas.height = h;
      this.hasDrawn = false;
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
          origRotation: 0,
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
     * Espaço "como na tela" da página: origem embaixo à esquerda, já considerando
     * a rotação e o recorte do PDF. `matrix` leva desse espaço para o do arquivo.
     */
    async getPageSpace(pageIndex) {
      const page = await this.pdfEngine.pdfDoc.getPage(pageIndex + 1);
      const vp = page.getViewport({ scale: 1 });
      const toPdf = (x, yUp) => {
        const [px, py] = vp.convertToPdfPoint(x, vp.height - yUp);
        return { x: px, y: py };
      };
      const o = toPdf(0, 0);
      const ux = toPdf(1, 0);
      const uy = toPdf(0, 1);
      return {
        width: vp.width,
        height: vp.height,
        rotation: vp.rotation,
        toPdf,
        matrix: [ux.x - o.x, ux.y - o.y, uy.x - o.x, uy.y - o.y, o.x, o.y]
      };
    }

    /**
     * Executa o desenho girado em torno de (cx, cy). `rotDeg` é horário, como no CSS.
     */
    async withRotation(page, cx, cy, rotDeg, draw) {
      if (!rotDeg) return draw();
      const { pushGraphicsState, popGraphicsState, concatTransformationMatrix } = PDFLib;
      const rad = (-rotDeg * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      page.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy)
      );
      await draw();
      page.pushOperators(popGraphicsState());
    }

    /** Remove os anexos de projeto que uma exportação anterior tenha deixado. */
    stripProjectAttachments(pdfDoc) {
      const { PDFName, PDFDict, PDFArray } = PDFLib;
      const ours = [PROJECT_ATTACHMENT_NAME, ORIGINAL_ATTACHMENT_NAME];
      const names = pdfDoc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
      const files = names?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
      const entries = files?.lookupMaybe(PDFName.of('Names'), PDFArray);
      if (!entries) return;
      const associated = pdfDoc.catalog.lookupMaybe(PDFName.of('AF'), PDFArray);
      for (let i = entries.size() - 2; i >= 0; i -= 2) {
        if (!ours.includes(entries.lookup(i).decodeText())) continue;
        const ref = entries.get(i + 1);
        for (let j = (associated?.size() || 0) - 1; j >= 0; j--) {
          if (associated.get(j) === ref) associated.remove(j);
        }
        entries.remove(i + 1);
        entries.remove(i);
      }
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
      const lines = Utils.wrapTextLines(item.text, Utils.keepsSingleLine(item) ? Infinity : Math.max(item.width - 4, 12), (s) => ctx.measureText(s).width);

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
    async drawTextBlock(pdfDoc, page, item, fontCache, pageH) {
      const cx = item.x + item.width / 2;
      const cy = pageH - (item.y + item.height / 2);
      await this.withRotation(page, cx, cy, item.rotation, () =>
        this.drawUprightText(pdfDoc, page, item, fontCache, pageH));
    }

    async drawUprightText(pdfDoc, page, item, fontCache, pageH) {
      const { rgb } = PDFLib;
      const opacity = item.opacity != null ? item.opacity : 1;

      // Fundo da caixa de texto (se não transparente)
      if (item.bgColor && !item.bgTransparent) {
        const bg = Utils.hexToRgb01(item.bgColor);
        page.drawRectangle({
          x: item.x, y: pageH - item.y - item.height, width: item.width, height: item.height,
          color: rgb(bg.r, bg.g, bg.b), opacity
        });
      }

      const text = String(item.text || '');
      if (!text.trim()) return;

      // Fallback para Unicode fora de WinAnsi
      if (!Utils.isWinAnsiSafe(text)) {
        const pngBytes = await this.rasterizeTextToPng({ ...item, bgTransparent: true });
        const img = await pdfDoc.embedPng(pngBytes);
        page.drawImage(img, {
          x: item.x, y: pageH - item.y - (item.height + 6),
          width: item.width + 6, height: item.height + 6, opacity
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

      const lines = Utils.wrapTextLines(text, Utils.keepsSingleLine(item) ? Infinity : maxW, (s) => font.widthOfTextAtSize(s, size));

      lines.forEach((line, idx) => {
        if (!line) return;
        const lineW = font.widthOfTextAtSize(line, size);
        let offsetX = 1;
        if (item.align === 'center') offsetX = Math.max(1, (item.width - lineW) / 2);
        else if (item.align === 'right') offsetX = Math.max(1, item.width - lineW - 1);

        const lineTopY = item.y + idx * lineH;
        const baselinePdfY = pageH - (lineTopY + size * 0.88);
        const drawX = item.x + offsetX;

        if (item.align === 'justify' && idx < lines.length - 1 && line.includes(' ')) {
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
            opacity
          });
        }

        // Sublinhado e Tachado vetoriais
        const decoThick = Math.max(0.6, size * 0.065);
        if (item.underline) {
          page.drawLine({
            start: { x: drawX, y: baselinePdfY - size * 0.14 },
            end: { x: drawX + lineW, y: baselinePdfY - size * 0.14 },
            thickness: decoThick, color: rgb(col.r, col.g, col.b), opacity
          });
        }
        if (item.strikethrough) {
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
      const { PDFDocument, StandardFonts, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix } = PDFLib;
      if (onProgress) onProgress(10, 'Carregando estrutura original do PDF...');

      const pdfDoc = await PDFDocument.load(this.pdfEngine.originalBytes.slice(), {
        ignoreEncryption: true
      });
      pdfDoc.setCreator('PDF Studio Pro');
      pdfDoc.setProducer('PDF Studio Pro (pdf-lib)');
      this.stripProjectAttachments(pdfDoc);

      const fontCache = new Map();
      const form = pdfDoc.getForm();
      const radioGroups = new Map();
      const usedFieldNames = new Set();
      form.getFields().forEach(f => {
        usedFieldNames.add(f.getName());
        usedFieldNames.add(f.getName().split('.')[0]);
      });
      const createdFields = new Set();
      const exportedFields = new Map(); // obj.id -> dados do campo gravado

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
        const pData = pagesState[pIdx];
        if (!pData) continue;
        const changedRuns = pData.textRuns.filter(r => r.edited || r.moved || r.deleted);
        if (!changedRuns.length && !pData.objects.length) continue;

        const space = await this.getPageSpace(pIdx);
        const pageH = space.height;
        page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...space.matrix));

        // 1. Máscaras de texto original editado, movido ou excluído
        for (const run of changedRuns) {
          const maskCol = Utils.hexToRgb01(run.maskColor || '#ffffff');
          await this.withRotation(page, run.origX + run.origW / 2, pageH - (run.origY + run.origH / 2), run.origRotation, () => {
            page.drawRectangle({
              x: run.origX - 1.5,
              y: pageH - (run.origY + run.origH) - 1.5,
              width: run.origW + 3,
              height: run.origH + 3,
              color: rgb(maskCol.r, maskCol.g, maskCol.b)
            });
          });
        }

        // 2. Textos originais editados / movidos (não excluídos)
        for (const run of changedRuns) {
          if (!run.deleted) {
            await this.drawTextBlock(pdfDoc, page, { ...run, bgTransparent: true }, fontCache, pageH);
          }
        }

        // 3. Objetos ordenados por zIndex
        const sortedObjs = [...pData.objects].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

        for (const obj of sortedObjs) {
          const op = obj.opacity != null ? obj.opacity : 1;
          const rot = obj.type === 'form' ? Utils.snapRightAngle(obj.rotation) : (obj.rotation || 0);
          const cx = obj.x + obj.width / 2;
          const cy = pageH - (obj.y + obj.height / 2);
          const yPdf = pageH - (obj.y + obj.height);
          const box = { x: obj.x, y: yPdf, width: obj.width, height: obj.height };

          if (obj.type === 'textbox') {
            await this.drawTextBlock(pdfDoc, page, obj, fontCache, pageH);
            continue;
          }

          if (obj.type === 'form') {
            const fName = uniqueFieldName(obj.fieldName || `campo_${obj.formType}`);
            const style = { borderWidth: 1, borderColor: rgb(0.15, 0.39, 0.92), backgroundColor: rgb(0.96, 0.98, 1) };
            // O widget não segue a matriz da página: posiciona direto no espaço do arquivo
            const placeWidget = (field) => {
              const widgets = field.acroField.getWidgets();
              const widget = widgets[widgets.length - 1];
              const sideways = Math.abs(rot % 180) === 90;
              const w = sideways ? obj.height : obj.width;
              const h = sideways ? obj.width : obj.height;
              const a = space.toPdf(cx - w / 2, cy - h / 2);
              const b = space.toPdf(cx + w / 2, cy + h / 2);
              widget.setRectangle({
                x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
                width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y)
              });
              widget.getOrCreateAppearanceCharacteristics()
                .setRotation((((space.rotation - rot) % 360) + 360) % 360);
              if (obj.required) field.enableRequired();
              createdFields.add(field);
            };

            if (obj.formType === 'text') {
              const tf = form.createTextField(fName);
              const value = obj.value && Utils.isWinAnsiSafe(obj.value) ? obj.value : '';
              if (value) tf.setText(value);
              tf.addToPage(page, { ...box, ...style });
              placeWidget(tf);
              exportedFields.set(obj.id, { exportName: fName, exportValue: value });
            } else if (obj.formType === 'checkbox') {
              const cb = form.createCheckBox(fName);
              cb.addToPage(page, { ...box, ...style });
              placeWidget(cb);
              if (obj.checked) cb.check();
              exportedFields.set(obj.id, { exportName: fName });
            } else if (obj.formType === 'radio') {
              const gName = (obj.radioGroup || 'grupo_radio').replace(/[^a-zA-Z0-9_-]/g, '_');
              let rg = radioGroups.get(gName);
              if (!rg) {
                rg = form.createRadioGroup(uniqueFieldName(gName));
                radioGroups.set(gName, rg);
              }
              const optVal = obj.value || fName;
              rg.addOptionToPage(optVal, page, { ...box, ...style });
              placeWidget(rg);
              if (obj.checked) rg.select(optVal);
              exportedFields.set(obj.id, { exportName: rg.getName(), exportOption: optVal });
            } else if (obj.formType === 'dropdown') {
              const dd = form.createDropdown(fName);
              const opts = (obj.options && obj.options.length ? obj.options : ['Opção 1', 'Opção 2'])
                .map(o => (Utils.isWinAnsiSafe(o) ? o : 'Opcao'));
              dd.addOptions(opts);
              const value = obj.value && opts.includes(obj.value) ? obj.value : '';
              if (value) dd.select(value);
              dd.addToPage(page, { ...box, ...style });
              placeWidget(dd);
              exportedFields.set(obj.id, { exportName: fName, exportValue: value });
            } else if (obj.formType === 'signature') {
              await this.withRotation(page, cx, cy, rot, async () => {
                page.drawRectangle({
                  ...box,
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
                }
              });
              if (!obj.signatureDataUrl) {
                const tf = form.createTextField(fName);
                tf.setText('Assinar aqui');
                tf.addToPage(page, { ...box, borderWidth: 1, borderColor: style.borderColor });
                placeWidget(tf);
              }
            }
            continue;
          }

          await this.withRotation(page, cx, cy, rot, async () => {
            if (obj.type === 'highlight') {
              const c = Utils.hexToRgb01(obj.color || '#fde047');
              page.drawRectangle({ ...box, color: rgb(c.r, c.g, c.b), opacity: Math.min(op, 0.38) });
            } else if (obj.type === 'image' || obj.type === 'signature') {
              if (!obj.dataUrl) return;
              try {
                const pngBytes = await Utils.dataUrlToPngBytes(obj.dataUrl);
                const embedded = await pdfDoc.embedPng(pngBytes);
                page.drawImage(embedded, { ...box, opacity: op });
              } catch (e) {
                console.warn('Imagem ignorada na exportação:', e);
              }
            } else if (obj.type === 'shape') {
              const sc = Utils.hexToRgb01(obj.strokeColor || '#2563eb');
              const fc = Utils.hexToRgb01(obj.fillColor || '#3b82f6');
              const sw = obj.strokeWidth != null ? obj.strokeWidth : 2;
              const hasFill = !obj.fillTransparent;
              const paint = {
                borderColor: sw > 0 ? rgb(sc.r, sc.g, sc.b) : undefined,
                borderWidth: sw,
                color: hasFill ? rgb(fc.r, fc.g, fc.b) : undefined,
                opacity: hasFill ? op : undefined,
                borderOpacity: op
              };

              if (obj.shapeType === 'rect') {
                page.drawRectangle({ ...box, ...paint });
              } else if (obj.shapeType === 'ellipse') {
                page.drawEllipse({ x: cx, y: cy, xScale: obj.width / 2, yScale: obj.height / 2, ...paint });
              } else if (obj.shapeType === 'line' || obj.shapeType === 'arrow') {
                const end = { x: obj.x + obj.width, y: cy };
                const line = { thickness: Math.max(1, sw), color: rgb(sc.r, sc.g, sc.b), opacity: op };
                page.drawLine({ start: { x: obj.x, y: cy }, end, ...line });
                if (obj.shapeType === 'arrow') {
                  const headLen = Math.max(8, sw * 4.5);
                  for (const a of [-Math.PI / 6, Math.PI / 6]) {
                    page.drawLine({
                      start: end,
                      end: { x: end.x - headLen * Math.cos(a), y: end.y - headLen * Math.sin(a) },
                      ...line
                    });
                  }
                }
              }
            } else if (obj.type === 'draw' && obj.points && obj.points.length > 1) {
              const sc = Utils.hexToRgb01(obj.strokeColor || '#2563eb');
              const sw = Math.max(1, obj.strokeWidth || 2);
              const mapPt = (pt) => ({ x: obj.x + pt.x * obj.width, y: pageH - (obj.y + pt.y * obj.height) });
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
              page.drawCircle({
                x: cx,
                y: cy,
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
                x: cx - 2.5,
                y: cy - 4,
                size: 11, font: fBold, color: rgb(0.26, 0.13, 0.02)
              });

              if (obj.text && obj.text.trim()) {
                const noteX = Math.min(obj.x + obj.width + 6, space.width - 165);
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
            }
          });
        }

        page.pushOperators(popGraphicsState());
      }

      if (createdFields.size) {
        const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
        createdFields.forEach(field => field.defaultUpdateAppearances(helvetica));
      }

      if (flattenForms) {
        try { form.flatten(); } catch (e) { console.warn('Aviso ao achatar formulário:', e); }
      }

      // No modo "PDF Editável", embutimos o estado completo das camadas em anexo JSON
      if (editable) {
        if (onProgress) onProgress(90, 'Embutindo camadas editáveis no PDF...');
        const payload = {
          version: 2,
          exportedAt: new Date().toISOString(),
          pages: pagesState.map(p => ({
            textRuns: p.textRuns.filter(r => r.edited || r.moved || r.deleted || r.fromOcr),
            objects: p.objects.map(o => ({ ...o, ...exportedFields.get(o.id) }))
          }))
        };
        await pdfDoc.attach(this.pdfEngine.originalBytes.slice(), ORIGINAL_ATTACHMENT_NAME, {
          mimeType: 'application/pdf',
          description: 'PDF Studio Pro Original Document'
        });
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
              ctx.save();
              ctx.translate(run.origX + run.origW / 2, run.origY + run.origH / 2);
              ctx.rotate(((run.origRotation || 0) * Math.PI) / 180);
              ctx.fillStyle = run.maskColor || '#ffffff';
              ctx.fillRect(-run.origW / 2 - 1.5, -run.origH / 2 - 1.5, run.origW + 3, run.origH + 3);
              ctx.restore();
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
      const lines = Utils.wrapTextLines(item.text, Utils.keepsSingleLine(item) ? Infinity : Math.max(item.width - 2, 12), (s) => ctx.measureText(s).width);

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

      this.lastPointerType = 'mouse';
      this.cacheDom();
      this.bindGlobalEvents();
      this.bindInterfaceEvents();
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

    /** Aberturas são feitas uma de cada vez, para um arquivo não se misturar com outro. */
    loadPdfBytes(uint8Array, fileName = 'documento.pdf') {
      const run = () => this.performLoad(uint8Array, fileName);
      this.loadQueue = (this.loadQueue || Promise.resolve()).then(run, run);
      return this.loadQueue;
    }

    async performLoad(uint8Array, fileName) {
      Utils.toast('Carregando documento PDF...', 'info', 1800);
      const { numPages, embeddedProject, exportedBytes, legacyProject } = await this.pdfEngine.loadFromBytes(uint8Array);
      this.renderGeneration++; // interrompe a renderização do documento anterior
      if (embeddedProject) await this.syncFormValues(exportedBytes, embeddedProject);

      this.state.fileName = fileName;
      this.state.numPages = numPages;
      this.state.currentPage = 0;
      this.state.selected = null;
      this.state.pages = [];
      this.state.zCounter = 10;
      this.history.clear();
      this.updateInspector();

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
      if (embeddedProject) {
        embeddedProject.pages.forEach((savedPage, idx) => {
          const pData = this.state.pages[idx];
          if (!pData) return;
          pData.objects = savedPage.objects;
          savedPage.objects.forEach(o => {
            this.state.zCounter = Math.max(this.state.zCounter, o.zIndex || 0);
          });
          for (const sr of savedPage.textRuns) {
            const match = !sr.fromOcr && pData.textRuns.find(
              r => r.origText === sr.origText && Math.abs(r.origX - sr.origX) < 3 && Math.abs(r.origY - sr.origY) < 3
            );
            if (match) Object.assign(match, sr, { id: match.id });
            else pData.textRuns.push(sr);
          }
        });
        Utils.toast('Projeto editável detectado e camadas restauradas!', 'success', 3800);
      } else if (legacyProject) {
        Utils.toast('PDF editável de uma versão antiga: as edições anteriores já fazem parte da página.', 'warning', 5000);
      }

      this.dom.welcomeScreen.hidden = true;
      this.dom.pagesContainer.hidden = false;
      this.dom.app.classList.remove('no-doc');
      this.closeSheets();
      this.updateToolUI();

      // No celular a página ocupa a largura; no computador, 125% quando couber
      this.fitMode = COMPACT.matches;
      const availW = this.dom.viewport.clientWidth - 90;
      const firstW = this.state.pages[0]?.width || 595;
      if (this.fitMode) {
        this.state.zoom = this.fitZoom();
      } else if (availW > 300 && firstW * 1.25 > availW) {
        this.state.zoom = Utils.clamp(Math.floor((availW / firstW) * 100) / 100, 0.5, 2.0);
      } else {
        this.state.zoom = 1.25;
      }
      this.syncZoomSelect();

      this.buildPagesDOM();
      this.dom.viewport.scrollTo(0, 0);
      await this.renderAllPages();
      await this.renderThumbnails();

      this.pushHistory();
      this.updateSidebars();
      this.syncCurrentPageUI();
      Utils.toast(`"${fileName}" carregado (${numPages} ${numPages === 1 ? 'página' : 'páginas'}).`, 'success');
      this.applyIntent();
    }

    /**
     * Traz para as camadas o que foi preenchido no PDF editável em outro leitor.
     */
    async syncFormValues(exportedBytes, project) {
      let form;
      try {
        const doc = await PDFLib.PDFDocument.load(exportedBytes, { ignoreEncryption: true });
        form = doc.getForm();
      } catch (err) {
        console.warn('Não foi possível ler os campos preenchidos:', err);
        return;
      }
      for (const obj of project.pages.flatMap(p => p.objects)) {
        const { exportName, exportValue, exportOption } = obj;
        delete obj.exportName;
        delete obj.exportValue;
        delete obj.exportOption;
        if (obj.type !== 'form' || !exportName) continue;
        try {
          if (obj.formType === 'text') {
            const current = form.getTextField(exportName).getText() || '';
            if (current !== exportValue) obj.value = current;
          } else if (obj.formType === 'dropdown') {
            const current = form.getDropdown(exportName).getSelected()[0] || '';
            if (current !== exportValue) obj.value = current;
          } else if (obj.formType === 'checkbox') {
            obj.checked = form.getCheckBox(exportName).isChecked();
          } else if (obj.formType === 'radio') {
            obj.checked = form.getRadioGroup(exportName).getSelected() === exportOption;
          }
        } catch (err) {
          console.warn(`Campo "${exportName}" não encontrado:`, err);
        }
      }
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

    sizePages() {
      this.pageElements.forEach((els, i) => {
        const pData = this.state.pages[i];
        els.pageBox.style.width = `${pData.width * this.state.zoom}px`;
        els.pageBox.style.height = `${pData.height * this.state.zoom}px`;
      });
    }

    /** Desenha só as páginas perto da tela; as outras entram conforme a rolagem. */
    async renderAllPages() {
      const gen = ++this.renderGeneration;
      this.pageObserver?.disconnect();
      this.renderJobs = new Map();
      this.sizePages();
      this.pageElements.forEach((els, i) => this.renderPageOverlays(i));

      this.pageObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          const i = Number(entry.target.dataset.pageIndex);
          if (entry.isIntersecting) this.renderPageCanvas(i, gen).catch(err => console.warn(err));
          else this.releasePageCanvas(i);
        });
      }, { root: this.dom.viewport, rootMargin: '600px 0px' });
      this.pageElements.forEach(els => this.pageObserver.observe(els.pageBox));

      await this.renderPageCanvas(this.state.currentPage, gen);
    }

    renderPageCanvas(i, gen) {
      const els = this.pageElements[i];
      if (gen !== this.renderGeneration || !els) return Promise.resolve();
      if (this.renderJobs.has(i)) return this.renderJobs.get(i);
      const job = this.pdfEngine.renderPageToCanvas(i, els.canvas, this.state.zoom)
        .then((viewport) => { if (!viewport && this.renderJobs.get(i) === job) this.renderJobs.delete(i); });
      this.renderJobs.set(i, job);
      return job;
    }

    releasePageCanvas(i) {
      // A página com seleção fica desenhada: a cor do fundo é lida dela
      if (!this.renderJobs?.has(i) || this.state.selected?.pageIndex === i || i === this.state.currentPage) return;
      this.renderJobs.delete(i);
      this.pdfEngine.releasePage(i, this.pageElements[i].canvas);
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
        item.addEventListener('click', () => { this.closeSheets(); this.goToPage(i); });
        this.dom.thumbnailsList.appendChild(item);

        c.width = 146;
        c.height = Math.round(146 * this.state.pages[i].height / this.state.pages[i].width);
      }

      // Cada miniatura é desenhada quando aparece pela primeira vez
      this.thumbObserver?.disconnect();
      this.thumbObserver = new IntersectionObserver((entries, observer) => {
        entries.filter(e => e.isIntersecting).forEach((e) => {
          observer.unobserve(e.target);
          const canvas = e.target.querySelector('canvas');
          this.pdfEngine.renderThumbnail(Number(e.target.dataset.pageIndex), canvas, 146).catch(() => {});
        });
      });
      this.dom.thumbnailsList.querySelectorAll('.thumb-item').forEach(el => this.thumbObserver.observe(el));
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
          els.maskLayer.appendChild(this.createTextMask(run, z));
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
          if (Utils.keepsSingleLine(run)) span.style.whiteSpace = 'pre';
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

    createTextMask(run, z) {
      const mask = document.createElement('div');
      mask.className = 'pdf-text-mask';
      mask.style.left = `${(run.origX - 1.5) * z}px`;
      mask.style.top = `${(run.origY - 1.5) * z}px`;
      mask.style.width = `${(run.origW + 3) * z}px`;
      mask.style.height = `${(run.origH + 3) * z}px`;
      mask.style.backgroundColor = run.maskColor || '#ffffff';
      if (run.origRotation) mask.style.transform = `rotate(${run.origRotation}deg)`;
      return mask;
    }

    /** Resumo do que, se mudar, torna o texto original "editado". */
    textSignature(run) {
      return JSON.stringify([run.text, run.fontFamily, run.fontSize, run.color, run.bold, run.italic,
        run.underline, run.strikethrough, run.align, run.lineHeight]);
    }

    buildTextDecoration(item) {
      const dec = [];
      if (item.underline) dec.push('underline');
      if (item.strikethrough) dec.push('line-through');
      return dec.length ? dec.join(' ') : 'none';
    }

    bindTextRunEvents(el, run, pageIndex) {
      let editStart = null;

      let wasSelected = false;
      const sampleOnce = () => {
        if (run.colorSampled) return;
        const sampled = this.pdfEngine.sampleColorsForRun(pageIndex, run);
        run.maskColor = sampled.bgHex;
        run.color = sampled.fgHex;
        run.colorSampled = true;
      };
      const isSelected = () => this.state.selected?.kind === 'textRun' && this.state.selected.id === run.id;

      const startEditing = () => {
        // Amostra cores exatas do canvas na primeira interação
        if (!run.colorSampled) {
          const sampled = this.pdfEngine.sampleColorsForRun(pageIndex, run);
          run.maskColor = sampled.bgHex;
          run.color = sampled.fgHex;
          run.colorSampled = true;
        }

        // Abrir o texto ainda não é editar: só marca como editado se algo mudar
        editStart = {
          wasEdited: run.edited,
          signature: this.textSignature(run),
          text: run.text,
          width: run.width,
          height: run.height
        };
        this.selectElement({ kind: 'textRun', pageIndex, id: run.id }, false);

        // Garante máscara imediata sob o texto ao abrir edição inline
        if (!run.edited && !run.moved) {
          const els = this.pageElements[pageIndex];
          els.maskLayer.appendChild(this.createTextMask(run, this.state.zoom));
        }

        el.querySelectorAll('.transform-handle, .rotate-stem, .handle-rotate').forEach(h => h.remove());
        el.classList.add('edited', 'editing');
        el.style.color = run.color;
        el.style.width = `${Math.max(run.width, 20) * this.state.zoom}px`;
        el.style.whiteSpace = Utils.keepsSingleLine(run) ? 'pre' : '';
        el.contentEditable = 'true';
        el.focus();

        // Sincroniza barra de formatação com este texto
        this.syncFormatBarFromItem(run);
        this.updateInspector();
      };
      el.startEditing = startEditing;

      const activateInlineEdit = (e) => {
        e.stopPropagation();
        if (el.contentEditable === 'true') return;

        // Fechar a edição anterior redesenha a página e troca este elemento
        const active = document.activeElement;
        if (active && active !== el && active.isContentEditable) active.blur();
        if (el.isConnected) {
          startEditing();
          return;
        }
        e.preventDefault();
        this.pageElements[pageIndex].textLayer
          .querySelector(`[data-run-id="${run.id}"]`)?.startEditing();
      };

      el.addEventListener('pointerdown', (e) => {
        wasSelected = isSelected();
        if (e.button === 2) {
          this.selectElement({ kind: 'textRun', pageIndex, id: run.id });
          return;
        }
        if (el.contentEditable === 'true') {
          e.stopPropagation();
          return;
        }
        // No toque, o primeiro contato pode ser rolagem: só arrasta o que já está selecionado
        if (e.pointerType === 'touch') {
          if (this.state.tool === 'select' && wasSelected) {
            e.stopPropagation();
            this.startDragElement(e, run, 'textRun', pageIndex);
          }
          return;
        }

        if (this.state.tool === 'edit-text') {
          activateInlineEdit(e);
        } else if (this.state.tool === 'select') {
          e.stopPropagation();
          sampleOnce();
          if (!wasSelected) this.selectElement({ kind: 'textRun', pageIndex, id: run.id });
          this.startDragElement(e, run, 'textRun', pageIndex);
        }
      });

      el.addEventListener('click', (e) => {
        if (this.lastPointerType !== 'touch' || el.contentEditable === 'true') return;
        if (this.state.tool === 'edit-text') {
          if (!COMPACT.matches) return activateInlineEdit(e);
          sampleOnce();
          this.selectElement({ kind: 'textRun', pageIndex, id: run.id });
          this.openTextModal();
        } else if (this.state.tool === 'select') {
          if (wasSelected) return this.editSelected();
          sampleOnce();
          this.selectElement({ kind: 'textRun', pageIndex, id: run.id });
        }
      });

      el.addEventListener('dblclick', (e) => {
        if (this.lastPointerType === 'touch') return;
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
          if (run.text !== editStart?.text) run.text = el.innerText.replace(/\r/g, '');
          // Voltou a ficar como estava: desfaz a marca de edição
          if (editStart && this.textSignature(run) === editStart.signature) {
            run.edited = editStart.wasEdited;
            run.width = editStart.width;
            run.height = editStart.height;
          }
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
          pop.addEventListener('pointerdown', (e) => e.stopPropagation());
          const head = document.createElement('div');
          head.className = 'comment-popover-head';
          for (const value of [obj.author || 'Revisor', obj.timestamp || '']) {
            const part = document.createElement('span');
            part.textContent = value;
            head.appendChild(part);
          }
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
          inp.readOnly = COMPACT.matches; // no celular o preenchimento abre uma caixa maior
          inp.addEventListener('pointerdown', (e) => {
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
          cb.addEventListener('pointerdown', (e) => e.stopPropagation());
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
          rb.addEventListener('pointerdown', (e) => e.stopPropagation());
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
          sel.addEventListener('pointerdown', (e) => { if (isSel) e.stopPropagation(); });
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
      let wasSelected = false;
      el.addEventListener('pointerdown', (e) => {
        wasSelected = this.state.selected?.id === obj.id;
        if (e.button === 2) {
          this.selectElement({ kind: 'object', pageIndex, id: obj.id });
          return;
        }
        if (this.state.tool !== 'select') return;
        if (el.classList.contains('editing-text')) return;
        if (e.pointerType === 'touch') {
          if (wasSelected) {
            e.stopPropagation();
            this.startDragElement(e, obj, 'object', pageIndex);
          }
          return;
        }
        e.stopPropagation();
        if (!wasSelected) this.selectElement({ kind: 'object', pageIndex, id: obj.id });
        this.startDragElement(e, obj, 'object', pageIndex);
      });

      el.addEventListener('click', (e) => {
        if (this.lastPointerType !== 'touch' || this.state.tool !== 'select') return;
        if (e.target.matches('input[type="checkbox"], input[type="radio"], select')) return;
        e.stopPropagation();
        if (!wasSelected) this.selectElement({ kind: 'object', pageIndex, id: obj.id });
        const fillsNow = obj.type === 'form' && (
          (obj.formType === 'text' && COMPACT.matches) ||
          (obj.formType === 'signature' && !obj.signatureDataUrl));
        if (wasSelected || fillsNow) this.editSelected();
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
        h.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.startResizeElement(e, item, kind, pageIndex, dir);
        });
        el.appendChild(h);
      }

      const stem = document.createElement('div');
      stem.className = 'rotate-stem';
      const rot = document.createElement('div');
      rot.className = 'handle-rotate';
      rot.title = 'Arraste para girar (Shift trava em 15°)';
      rot.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.startRotateElement(e, item, kind, pageIndex, el);
      });
      el.append(stem, rot);
    }

    /** Acompanha um único dedo ou o mouse até soltar. */
    trackPointer(e, onMove, onEnd) {
      const id = e.pointerId;
      const move = (ev) => { if (ev.pointerId === id) onMove(ev); };
      const up = (ev) => { if (ev.pointerId === id) finish(false); };
      const cancel = (ev) => { if (ev.pointerId === id) finish(true); };
      const finish = (cancelled) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', cancel);
        this.cancelGesture = null;
        onEnd(cancelled);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', cancel);
      this.cancelGesture = () => finish(true);
    }

    /**
     * Atualiza o elemento durante o gesto sem recriá-lo: recriar derruba o toque
     * em alguns celulares e deixa o arrasto lento.
     */
    previewElement(item, kind, pageIndex) {
      const els = this.pageElements[pageIndex];
      const z = this.state.zoom;
      const node = kind === 'object'
        ? els.objectsLayer.querySelector(`[data-obj-id="${item.id}"]`)
        : els.textLayer.querySelector(`[data-run-id="${item.id}"]`);
      if (!node) return;
      node.style.left = `${item.x * z}px`;
      node.style.top = `${item.y * z}px`;
      node.style.transform = item.rotation ? `rotate(${item.rotation}deg)` : '';
      if (kind === 'object') {
        node.style.width = `${item.width * z}px`;
        node.style.height = `${item.height * z}px`;
      } else {
        node.style.minWidth = `${item.width * z}px`;
        node.style.width = `${item.width * z}px`;
        node.style.minHeight = `${item.height * z}px`;
        node.style.color = item.color || '#111111';
        if (!node.dataset.masked) {
          node.dataset.masked = '1';
          els.maskLayer.appendChild(this.createTextMask(item, z));
        }
      }
    }

    /** Encerra um gesto de transformação: grava o histórico e redesenha. */
    finishTransform(changed, pageIndex) {
      if (!changed) return;
      this.pushHistory();
      this.renderPageOverlays(pageIndex);
      this.updateInspector();
      this.updateSidebars();
    }

    startDragElement(e, item, kind, pageIndex) {
      const startX = e.clientX;
      const startY = e.clientY;
      const origX = item.x;
      const origY = item.y;
      const z = this.state.zoom;
      const slack = e.pointerType === 'touch' ? 6 : 2;
      let moved = false;

      this.trackPointer(e, (ev) => {
        const dx = (ev.clientX - startX) / z;
        const dy = (ev.clientY - startY) / z;
        if (!moved && Math.hypot(dx * z, dy * z) < slack) return;
        moved = true;
        item.x = Utils.round1(origX + dx);
        item.y = Utils.round1(origY + dy);
        if (kind === 'textRun') item.moved = true;
        this.previewElement(item, kind, pageIndex);
        this.updateInspector();
      }, () => this.finishTransform(moved, pageIndex));
    }

    startResizeElement(e, item, kind, pageIndex, dir) {
      const startX = e.clientX;
      const startY = e.clientY;
      const o = { x: item.x, y: item.y, w: item.width, h: item.height };
      const aspect = item.aspectRatio || (o.w / Math.max(o.h, 1));
      const keepsRatio = (item.type === 'image' || item.type === 'signature') && item.lockAspect !== false;
      const z = this.state.zoom;
      let changed = false;

      this.trackPointer(e, (ev) => {
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

        if (keepsRatio && !ev.shiftKey && dir.length === 2) {
          nh = Math.max(8, nw / aspect);
          if (dir.includes('n')) ny = o.y + (o.h - nh);
        }

        item.x = Utils.round1(nx);
        item.y = Utils.round1(ny);
        item.width = Utils.round1(nw);
        item.height = Utils.round1(nh);
        if (kind === 'textRun') item.moved = true;

        this.previewElement(item, kind, pageIndex);
        this.updateInspector();
      }, () => this.finishTransform(changed, pageIndex));
    }

    startRotateElement(e, item, kind, pageIndex, el) {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      let changed = false;

      this.trackPointer(e, (ev) => {
        changed = true;
        let angle = Math.atan2(ev.clientY - cy, ev.clientX - cx) * (180 / Math.PI) + 90;
        if (ev.shiftKey) angle = Math.round(angle / 15) * 15;
        else angle = Math.round(angle);
        if (angle > 180) angle -= 360;
        if (angle < -180) angle += 360;
        // com o dedo é difícil acertar o ângulo reto: encaixa quando chega perto
        if (ev.pointerType === 'touch' && Math.abs(angle - Utils.snapRightAngle(angle)) <= 4) angle = Utils.snapRightAngle(angle);
        item.rotation = item.type === 'form' ? Utils.snapRightAngle(angle) : angle;
        if (kind === 'textRun') item.moved = true;
        this.previewElement(item, kind, pageIndex);
        this.updateInspector();
      }, () => this.finishTransform(changed, pageIndex));
    }

    /* ------------------------------------------------------------------------
       INTERAÇÕES NA PÁGINA (CRIAÇÃO DE ANOTAÇÕES, FORMAS, DESENHO, FORMULÁRIOS)
       ------------------------------------------------------------------------ */
    bindPageInteractionEvents(pageBox, pageIndex) {
      const pointOf = (e) => {
        const rect = pageBox.getBoundingClientRect();
        return {
          x: (e.clientX - rect.left) / this.state.zoom,
          y: (e.clientY - rect.top) / this.state.zoom
        };
      };
      const isBlank = (target) => target === pageBox ||
        target.classList.contains('text-overlay-layer') || target.classList.contains('objects-layer');

      pageBox.addEventListener('pointermove', (e) => {
        const p = pointOf(e);
        this.dom.statusCoords.textContent = `X: ${Utils.round1(p.x)} pt · Y: ${Utils.round1(p.y)} pt`;
      });

      pageBox.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (this.lastPointerType !== 'touch') this.openContextMenu(e.clientX, e.clientY);
      });

      pageBox.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !e.isPrimary) return;
        this.closeContextMenu();
        this.state.currentPage = pageIndex;
        this.syncCurrentPageUI();

        const start = pointOf(e);
        if (this.state.tool === 'select') {
          if (e.pointerType !== 'touch' && isBlank(e.target)) this.selectElement(null);
          return;
        }

        if (this.state.tool === 'draw') {
          e.preventDefault();
          this.handleFreehandDraw(e, pageBox, pageIndex, start.x, start.y);
          return;
        }

        if (['textbox', 'highlight', 'shape', 'form'].includes(this.state.tool)) {
          e.preventDefault();
          this.handleBoxCreation(e, pageBox, pageIndex, start.x, start.y);
        }
      });

      pageBox.addEventListener('click', (e) => {
        if (this.state.tool === 'select') {
          if (this.lastPointerType === 'touch' && isBlank(e.target)) this.selectElement(null);
          return;
        }
        if (this.state.tool !== 'comment') return;
        const p = pointOf(e);
        const obj = {
          id: Utils.uid('cmt'),
          type: 'comment',
          pageIndex,
          x: Utils.round1(p.x - 13),
          y: Utils.round1(p.y - 13),
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
        if (COMPACT.matches) this.openTextModal();
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

      const onUp = (cancelled) => {
        path.remove();

        if (cancelled || rawPoints.length < 2) return;
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

      this.trackPointer(e, onMove, onUp);
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

      const onUp = (cancelled) => {
        preview.remove();
        if (cancelled) return;

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
        if (obj.type === 'textbox' && COMPACT.matches) {
          this.openTextModal({ isNew: true });
        } else if (obj.type === 'textbox') {
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

      this.trackPointer(e, onMove, onUp);
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

        // Coloca no meio da parte da página que está na tela
        const box = this.pageElements[pageIndex].pageBox.getBoundingClientRect();
        const view = this.dom.viewport.getBoundingClientRect();
        const middle = (view.top + view.height / 2 - box.top) / this.state.zoom;
        const centerY = Utils.clamp(middle, h / 2, Math.max(h / 2, pData.height - h / 2));

        const obj = {
          id: Utils.uid(type === 'signature' ? 'sig' : 'img'),
          type,
          pageIndex,
          x: Utils.round1((pData.width - w) / 2),
          y: Utils.round1(centerY - h / 2),
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
          const sampled = this.pdfEngine.sampleColorsForRun(pageIndex, item);
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
      this.fillInspector();
      this.refreshChrome();
    }

    fillInspector() {
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
          signature: 'Assinatura',
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
            <div class="layer-row-meta"></div>
          </div>
        `;
        row.querySelector('.layer-row-title').textContent = String(entry.title).slice(0, 42);
        row.querySelector('.layer-row-meta').textContent = entry.meta;
        row.addEventListener('click', () => {
          this.closeSheets();
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
            <strong></strong>
            <span></span>
          </div>
          <div class="comment-row-body"></div>
        `;
        row.querySelector('strong').textContent = `${obj.author || 'Revisor'} · Pág. ${pageIndex + 1}`;
        row.querySelector('.comment-row-head span').textContent = obj.timestamp || '';
        row.querySelector('.comment-row-body').textContent = obj.text || '(Sem texto — clique para editar)';
        row.addEventListener('click', () => {
          this.closeSheets();
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
          const sampled = this.pdfEngine.sampleColorsForRun(pageIndex, item);
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
        // Linhas do OCR vão inteiras, para poderem ser removidas e recriadas
        textRuns: p.textRuns.map(r => (r.fromOcr ? { ...r } : {
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
        pData.textRuns = pData.textRuns.filter(r => !r.fromOcr || map.has(r.id));
        pData.textRuns.forEach(r => {
          const saved = map.get(r.id);
          if (saved) Object.assign(r, saved);
        });
        const present = new Set(pData.textRuns.map(r => r.id));
        pSnap.textRuns
          .filter(r => r.fromOcr && !present.has(r.id))
          .forEach(r => pData.textRuns.push({ ...r }));
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
      this.dom.statusToolBadge.textContent = meta.label;
      this.dom.statusHint.textContent = this.state.numPages ? meta.hint : 'Abra um PDF para começar.';
      this.refreshChrome();

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
      document.getElementById('mobilePageLabel').textContent = `${this.state.currentPage + 1} / ${this.state.numPages}`;
      document.getElementById('btnPrevPage').disabled = this.state.currentPage <= 0;
      document.getElementById('btnNextPage').disabled = this.state.currentPage >= this.state.numPages - 1;
      this.dom.thumbnailsList.querySelectorAll('.thumb-item').forEach((el, i) => {
        el.classList.toggle('active', i === this.state.currentPage);
      });
      this.updateStatusBar();
    }

    fitZoom() {
      const page = this.state.pages[this.state.currentPage] || { width: 595 };
      const width = this.dom.viewport.clientWidth - 24;
      return Utils.clamp(Math.floor((width / page.width) * 100) / 100, 0.25, 2);
    }

    /** `anchor` é o ponto da área de visão que deve continuar parado durante o zoom. */
    async setZoom(newZoom, anchor) {
      if (!this.state.numPages) return;
      const view = this.dom.viewport.getBoundingClientRect();
      const ax = view.left + (anchor ? anchor.x : view.width / 2);
      const ay = view.top + (anchor ? anchor.y : view.height / 2);
      const boxes = this.pageElements.map(els => els.pageBox);
      const held = boxes.find(b => b.getBoundingClientRect().bottom >= ay) || boxes[boxes.length - 1];
      const before = held.getBoundingClientRect();
      const fx = (ax - before.left) / before.width;
      const fy = (ay - before.top) / before.height;

      this.state.zoom = Utils.clamp(Math.round(newZoom * 100) / 100, 0.25, 3.5);
      this.syncZoomSelect();
      this.sizePages();
      const after = held.getBoundingClientRect();
      this.dom.viewport.scrollLeft += after.left + fx * after.width - ax;
      this.dom.viewport.scrollTop += after.top + fy * after.height - ay;
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
          // Ignora linhas que já existem na página (texto nativo ou OCR anterior)
          const existing = this.state.pages[pIdx].textRuns
            .map(r => Utils.rotatedBounds(r.origX, r.origY, r.origW, r.origH, r.origRotation));
          const fresh = runs.filter(n => {
            const x = n.origX + n.origW / 2;
            const y = n.origY + n.origH / 2;
            return !existing.some(b => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height);
          });
          this.state.pages[pIdx].textRuns.push(...fresh);
          totalFound += fresh.length;
          this.renderPageOverlays(pIdx);
        }

        this.pushHistory();
        this.setTool('edit-text');
        document.getElementById('ocrModal').hidden = true;
        Utils.toast(`OCR concluído! ${totalFound} linhas novas de texto prontas para edição.`, 'success', 4200);
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
      const chooseFile = (intent = null) => {
        this.pendingIntent = intent;
        this.dom.pdfFileInput.click();
      };
      document.getElementById('btnOpenPdf').addEventListener('click', () => chooseFile());
      document.getElementById('btnWelcomeOpen').addEventListener('click', () => chooseFile());
      document.querySelectorAll('.route').forEach(route => {
        route.addEventListener('click', () => chooseFile(route.dataset.intent));
      });
      this.dom.pdfFileInput.addEventListener('change', (e) => {
        if (e.target.files[0]) this.openPdfFile(e.target.files[0]);
        e.target.value = '';
      });

      document.getElementById('btnCreateSample').addEventListener('click', async () => {
        this.pendingIntent = null;
        const bytes = await SamplePDFGenerator.createDemoPdf();
        await this.loadPdfBytes(bytes, 'Relatorio-Demonstracao.pdf');
      });

      document.getElementById('btnCreateBlank').addEventListener('click', async () => {
        this.pendingIntent = null;
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
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        document.querySelector('meta[name="theme-color"]').content = next === 'dark' ? '#0a1729' : '#10233d';
        try { localStorage.setItem('pdf-studio-theme', next); } catch { /* sem armazenamento */ }
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
      document.getElementById('btnZoomOut').addEventListener('click', () => { this.fitMode = false; this.setZoom(this.state.zoom - 0.15); });
      document.getElementById('btnZoomIn').addEventListener('click', () => { this.fitMode = false; this.setZoom(this.state.zoom + 0.15); });
      this.dom.zoomSelect.addEventListener('change', () => {
        const v = this.dom.zoomSelect.value;
        const p = this.state.pages[this.state.currentPage];
        if (!p) return;
        this.fitMode = v === 'fit-width';
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
        menu.style.left = `${Math.min(r.right + 8, window.innerWidth - 232)}px`;
        menu.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - menu.offsetHeight - 8))}px`;
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
      bindPropInput('propRotation', (info, el) => { const deg = parseFloat(el.value) || 0; info.item.rotation = info.item.type === 'form' ? Utils.snapRightAngle(deg) : deg; el.value = info.item.rotation; if (info.kind === 'textRun') info.item.moved = true; });
      bindPropInput('propOpacity', (info, el) => { info.item.opacity = Utils.clamp((parseFloat(el.value) || 100) / 100, 0.05, 1); if (info.kind === 'textRun') info.item.edited = true; });

      bindPropInput('propMaskColor', (info, el) => { info.item.maskColor = el.value; info.item.edited = true; });
      document.getElementById('btnAutoMaskColor').addEventListener('click', () => {
        const info = this.getSelectedItem();
        if (!info || info.kind !== 'textRun') return;
        const sampled = this.pdfEngine.sampleColorsForRun(info.pageIndex, info.item);
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
        r.rotation = r.origRotation || 0; r.opacity = 1; r.edited = false; r.moved = false; r.deleted = false;
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
            this.editSelected();
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
          this.closeSheets();
          if (this.textEdit) this.closeTextModal(false);
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
        if (ctrl && ['+', '=', '-', '_'].includes(e.key) && this.state.numPages) {
          e.preventDefault();
          const step = e.key === '-' || e.key === '_' ? -0.15 : 0.15;
          this.setZoom(this.state.zoom + step);
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
        if (ctrl || e.altKey) return;
        if (e.key.toLowerCase() === 'i') {
          document.getElementById('btnInsertImage').click();
          return;
        }
        const keyMap = { v: 'select', t: 'edit-text', x: 'textbox', h: 'highlight', c: 'comment', d: 'draw', s: 'shape' };
        const mapped = keyMap[e.key.toLowerCase()];
        if (mapped) {
          this.setTool(mapped);
        }
      });
    }
  }

  /* ==========================================================================
     9. INTERFACE: FOLHAS, BARRAS DO CELULAR E GESTOS
     ========================================================================== */
  Object.assign(PDFEditorApp.prototype, {
    /** Cor da linha, opções visíveis e barra de seleção conforme ferramenta e item. */
    refreshChrome() {
      const app = this.dom.app;
      const info = this.getSelectedItem();
      const tool = this.state.tool;
      const type = info ? (info.kind === 'textRun' ? 'textRun' : info.item.type) : null;
      const lines = {
        textRun: 'text', textbox: 'mark', form: 'mark', signature: 'sign',
        highlight: 'insert', comment: 'insert', draw: 'insert', shape: 'insert', image: 'insert'
      };
      const picked = Boolean(info) && tool === 'select';

      let ctx = 'none';
      // com a ferramenta Mover valem as opções do item; nas outras, as da ferramenta
      const target = tool === 'select' ? type : tool;
      if (['textRun', 'textbox', 'edit-text'].includes(target)) ctx = 'text';
      else if (['shape', 'draw', 'highlight'].includes(target)) ctx = 'style';

      app.dataset.ctx = ctx;
      app.dataset.line = picked ? lines[type] : (TOOL_META[tool] || TOOL_META.select).line;
      app.classList.toggle('has-selection', picked);

      const inDock = ['select', 'edit-text', 'signature', 'textbox'];
      document.querySelectorAll('.dock-btn[data-dock]').forEach(btn => {
        const on = btn.dataset.dock === tool || (btn.dataset.dock === 'more' && !inDock.includes(tool));
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', String(on));
        if (btn.dataset.dock === 'more') btn.dataset.line = on ? TOOL_META[tool].line : 'move';
      });

      const edit = document.querySelector('[data-act="edit"]');
      edit.disabled = !['textRun', 'textbox', 'comment', 'form'].includes(type);
    },

    openSheet(id) {
      this.closeSheets();
      const sheet = document.getElementById(id);
      sheet.classList.remove('collapsed');
      sheet.classList.add('open');
      document.getElementById('sheetBackdrop').classList.add('open');
      sheet.querySelector('.sheet-close')?.focus({ preventScroll: true });
    },

    closeSheets() {
      document.querySelectorAll('.sidebar.open, .sheet.open').forEach(s => {
        s.classList.remove('open');
        s.style.transform = '';
      });
      document.getElementById('sheetBackdrop').classList.remove('open');
    },

    /** No celular os controles de formatação vão para a folha de ajustes. */
    placeFormatControls() {
      const sections = [document.querySelector('.format-section'), document.querySelector('.style-section')];
      const options = document.getElementById('contextOptions');
      if (COMPACT.matches) document.getElementById('formatHost').append(...sections);
      else options.prepend(...sections);
    },

    applyIntent() {
      const intent = this.pendingIntent;
      this.pendingIntent = null;
      if (!intent) return;
      if (intent === 'signature') this.signatureManager.open();
      else this.setTool(intent);
    },

    /** Abre a edição do item selecionado da forma que cabe na tela. */
    editSelected() {
      const info = this.getSelectedItem();
      if (!info) return;
      const { item, kind, pageIndex } = info;
      if (item.type === 'form' && item.formType === 'signature') {
        this.signatureManager.open(item.id);
      } else if (item.type === 'form' && ['checkbox', 'radio'].includes(item.formType)) {
        if (item.formType === 'radio') {
          this.state.pages[pageIndex].objects
            .filter(o => o.formType === 'radio' && o.radioGroup === item.radioGroup)
            .forEach(o => { o.checked = false; });
        }
        item.checked = item.formType === 'radio' ? true : !item.checked;
        this.pushHistory();
        this.renderPageOverlays(pageIndex);
        this.updateInspector();
      } else if (item.type === 'form' && item.formType === 'dropdown') {
        this.openSheet('rightSidebar');
      } else if (COMPACT.matches) {
        this.openTextModal();
      } else if (kind === 'textRun') {
        this.pageElements[pageIndex].textLayer.querySelector(`[data-run-id="${item.id}"]`)?.startEditing();
      } else if (item.type === 'textbox') {
        this.pageElements[pageIndex].objectsLayer
          .querySelector(`[data-obj-id="${item.id}"] .obj-textbox-content`)
          ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      }
    },

    /** Caixa grande para escrever no celular, com a página atualizando junto. */
    openTextModal({ isNew = false } = {}) {
      const info = this.getSelectedItem();
      if (!info) return;
      const { item, kind, pageIndex } = info;
      let field = 'text';
      let title = kind === 'textRun' ? 'Corrigir texto' : 'Escrever';
      if (item.type === 'comment') title = 'Comentário';
      if (item.type === 'form') {
        if (item.formType !== 'text') return;
        field = 'value';
        title = 'Preencher campo';
      } else if (kind === 'object' && !['textbox', 'comment'].includes(item.type)) {
        return;
      }

      this.textEdit = { item, kind, pageIndex, field, isNew, before: { ...item } };
      const input = document.getElementById('textModalInput');
      document.getElementById('textModalTitle').textContent = title;
      input.value = isNew ? '' : (item[field] || '');
      input.placeholder = 'Digite aqui';
      document.getElementById('textModal').hidden = false;
      input.focus();
    },

    previewText(value) {
      const edit = this.textEdit;
      if (!edit) return;
      const { item, kind, pageIndex, field, before } = edit;
      item[field] = value;
      if (kind === 'textRun') item.edited = before.edited || value !== before.text;
      this.renderPageOverlays(pageIndex);
      if (item.type === 'textbox') {
        const inner = this.pageElements[pageIndex].objectsLayer
          .querySelector(`[data-obj-id="${item.id}"] .obj-textbox-content`);
        const needed = inner ? Utils.round1(inner.scrollHeight / this.state.zoom) : 0;
        if (needed > item.height) {
          item.height = needed;
          this.renderPageOverlays(pageIndex);
        }
      }
    },

    closeTextModal(apply) {
      const edit = this.textEdit;
      if (!edit) return;
      this.textEdit = null;
      document.getElementById('textModal').hidden = true;
      const { item, pageIndex, isNew, before } = edit;
      const empty = isNew && !String(document.getElementById('textModalInput').value).trim();

      if (isNew && (!apply || empty)) {
        const page = this.state.pages[pageIndex];
        page.objects = page.objects.filter(o => o.id !== item.id);
        this.state.selected = null;
      } else if (!apply) {
        Object.assign(item, before);
      }
      this.pushHistory();
      this.renderPageOverlays(pageIndex);
      this.updateInspector();
      this.updateSidebars();
    },

    bindInterfaceEvents() {
      this.dom.app = document.getElementById('app');
      window.addEventListener('pointerdown', (e) => { this.lastPointerType = e.pointerType || 'mouse'; }, true);

      this.placeFormatControls();
      // Em telas estreitas de computador, as miniaturas começam recolhidas
      if (window.innerWidth <= 1100) this.dom.leftSidebar.classList.add('collapsed');
      COMPACT.addEventListener('change', () => {
        this.closeSheets();
        this.placeFormatControls();
        if (COMPACT.matches && this.state.numPages) {
          this.fitMode = true;
          this.setZoom(this.fitZoom());
        }
      });

      document.getElementById('sheetBackdrop').addEventListener('click', () => this.closeSheets());
      document.querySelectorAll('.sheet-close').forEach(b => b.addEventListener('click', () => this.closeSheets()));
      document.getElementById('btnMobilePages').addEventListener('click', () => this.openSheet('leftSidebar'));
      document.getElementById('btnMobileFit').addEventListener('click', () => {
        this.fitMode = true;
        this.setZoom(this.fitZoom());
      });

      document.querySelectorAll('.dock-btn[data-dock]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const tool = btn.dataset.dock;
          if (tool === 'more') return this.openSheet('moreSheet');
          if (tool === 'signature') return this.signatureManager.open();
          this.setTool(tool !== 'select' && this.state.tool === tool ? 'select' : tool);
          if (tool !== 'select') this.selectElement(null);
        });
      });

      document.querySelectorAll('.sheet-tool').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const { pick, variant, click } = btn.dataset;
          this.closeSheets();
          if (click) return document.getElementById(click).click();
          if (!this.state.numPages) return Utils.toast('Abra um PDF primeiro.', 'warning');
          if (pick === 'image') return this.dom.imageFileInput.click();
          if (pick === 'shape') this.state.shapeType = variant;
          if (pick === 'form') this.state.formType = variant;
          this.selectElement(null);
          this.setTool(pick);
        });
      });

      const actions = {
        edit: () => this.editSelected(),
        duplicate: () => this.duplicateSelected(),
        adjust: () => this.openSheet('rightSidebar'),
        delete: () => this.deleteSelected(),
        done: () => this.selectElement(null)
      };
      document.querySelectorAll('[data-act]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          actions[btn.dataset.act]();
        });
      });

      const input = document.getElementById('textModalInput');
      input.addEventListener('input', () => this.previewText(input.value));
      document.getElementById('btnTextApply').addEventListener('click', () => this.closeTextModal(true));
      document.getElementById('btnTextCancel').addEventListener('click', () => this.closeTextModal(false));

      this.bindSheetSwipe();
      this.bindPinchZoom();

      // Girar o aparelho reajusta a página; abrir o teclado (só altura) não
      let lastWidth = window.innerWidth;
      let timer;
      window.addEventListener('resize', () => {
        if (window.innerWidth === lastWidth) return;
        lastWidth = window.innerWidth;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (this.fitMode && this.state.numPages) this.setZoom(this.fitZoom());
        }, 180);
      });
    },

    /** Puxar a alça para baixo fecha a folha. */
    bindSheetSwipe() {
      document.querySelectorAll('.sheet-grab').forEach(grab => {
        grab.addEventListener('pointerdown', (e) => {
          const sheet = grab.parentElement;
          const startY = e.clientY;
          const startedAt = performance.now();
          let dy = 0;
          sheet.style.transition = 'none';
          this.trackPointer(e, (ev) => {
            dy = Math.max(0, ev.clientY - startY);
            sheet.style.transform = `translateY(${dy}px)`;
          }, (cancelled) => {
            sheet.style.transition = '';
            sheet.style.transform = '';
            const speed = dy / Math.max(1, performance.now() - startedAt);
            if (!cancelled && (dy > 110 || (dy > 20 && speed > 0.45))) this.closeSheets();
          });
        });
      });
    },

    /** Dois dedos: amplia e desloca a página. */
    bindPinchZoom() {
      const view = this.dom.viewport;
      const pages = this.dom.pagesContainer;
      let pinch = null;
      const read = (touches) => {
        const rect = view.getBoundingClientRect();
        const [a, b] = touches;
        return {
          d: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
          x: (a.clientX + b.clientX) / 2 - rect.left,
          y: (a.clientY + b.clientY) / 2 - rect.top
        };
      };

      view.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 2 || !this.state.numPages) return;
        this.cancelGesture?.();
        const start = read(e.touches);
        pinch = { start, now: start, scale: 1 };
        pages.style.transformOrigin = `${start.x + view.scrollLeft}px ${start.y + view.scrollTop}px`;
      }, { passive: true });

      view.addEventListener('touchmove', (e) => {
        if (!pinch || e.touches.length !== 2) return;
        e.preventDefault();
        pinch.now = read(e.touches);
        const z = this.state.zoom;
        pinch.scale = Utils.clamp(pinch.now.d / pinch.start.d, 0.25 / z, 3.5 / z);
        pages.style.transform = `translate(${pinch.now.x - pinch.start.x}px, ${pinch.now.y - pinch.start.y}px) scale(${pinch.scale})`;
      }, { passive: false });

      const end = async (e) => {
        if (!pinch || e.touches.length >= 2) return;
        const { start, now, scale } = pinch;
        pinch = null;
        pages.style.transform = '';
        if (Math.abs(scale - 1) > 0.03) {
          this.fitMode = false;
          const done = this.setZoom(this.state.zoom * scale, start);
          view.scrollBy(start.x - now.x, start.y - now.y);
          await done;
        } else {
          view.scrollBy(start.x - now.x, start.y - now.y);
        }
      };
      view.addEventListener('touchend', end);
      view.addEventListener('touchcancel', end);
    }
  });

  // Inicialização segura quando o DOM estiver pronto
  window.addEventListener('DOMContentLoaded', () => {
    window.pdfEditorApp = new PDFEditorApp();
  });
})();
