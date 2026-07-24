import type { Content } from "pdfmake/interfaces";

export async function buildReferralPdfBase64(artifactHtml: string): Promise<string> {
  const [{ default: pdfMake }, { default: pdfFonts }, { default: htmlToPdfmake }] =
    await Promise.all([
      import("pdfmake/build/pdfmake"),
      import("pdfmake/build/vfs_fonts"),
      import("html-to-pdfmake"),
    ]);
  pdfMake.addVirtualFileSystem(pdfFonts);

  const document = new DOMParser().parseFromString(artifactHtml, "text/html");
  const sections = [...document.body.querySelectorAll("section.page-break")];
  sections.slice(1).forEach((section) => {
    (section as HTMLElement).style.pageBreakBefore = "always";
  });
  const content = htmlToPdfmake(document.body.innerHTML, {
    window,
    removeExtraBlanks: true,
    defaultStyles: {
      h1: { fontSize: 18, bold: true, marginBottom: 10 },
      h2: { fontSize: 14, bold: true, marginTop: 8, marginBottom: 8 },
      p: { fontSize: 10, lineHeight: 1.25, marginBottom: 5 },
      li: { fontSize: 10, lineHeight: 1.2 },
    },
  }) as Content;

  return pdfMake.createPdf({
    content,
    pageSize: "LETTER",
    pageMargins: [42, 42, 42, 42],
    defaultStyle: { font: "Roboto", fontSize: 10 },
  }).getBase64();
}
