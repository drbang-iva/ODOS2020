import { XMLParser, XMLValidator } from "fast-xml-parser";
export const VISIONWEB_UNREADABLE = "VisionWeb returned a response ODOS could not read.";
export interface VisionWebUploadResult {
  orderId: string;
  vwebOrderId?: string;
  vwebExchangeId?: string;
  supplierId: string;
  status: "Sent" | "Review" | "Error";
  errorList?: string;
}
export function parseVisionWebUploadResponse(xml: string): VisionWebUploadResult {
  try {
    const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false, trimValues: false });
    function parse(value: string) {
      if (XMLValidator.validate(value) !== true || /<!DOCTYPE/i.test(value)) throw new Error();
      return parser.parse(value);
    }
    let doc = parse(xml);
    if (doc.Envelope) {
      const inner = doc.Envelope?.Body?.UploadFileResponse?.UploadFileResult;
      if (typeof inner !== "string") throw new Error();
      doc = parse(inner);
    }
    const single = doc.SingleOrder;
    if (!single || typeof single !== "object" || Array.isArray(single)) throw new Error();
    const required = (key: string): string => {
      if (typeof single[key] !== "string" || !single[key].trim()) throw new Error();
      return single[key].trim();
    };
    const optional = (key: string): string | undefined => {
      if (single[key] === undefined || single[key] === "") return undefined;
      return required(key);
    };
    const status = required("Status");
    if (status !== "Sent" && status !== "Review" && status !== "Error") throw new Error();
    return { orderId: required("OrderId"), supplierId: required("SupplierId"), status,
      vwebOrderId: optional("VWebOrderId"), vwebExchangeId: optional("VWebExchangeId"), errorList: optional("ErrorList") };
  } catch { throw new Error(VISIONWEB_UNREADABLE); }
}
