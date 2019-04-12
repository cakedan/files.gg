import PDFJS from 'pdfjs-dist';
import PDFJSWorker from 'worker-loader!pdfjs-dist/build/pdf.worker';

PDFJS.GlobalWorkerOptions.workerPort = new PDFJSWorker();

import 'pdfjs-dist/web/pdf_viewer.css';
import * as PDFJSViewer from 'pdfjs-dist/web/pdf_viewer.js';

PDFJS.pdfjsViewer = PDFJSViewer;

export default PDFJS;
