/**
 * 文件类型识别。
 *
 * 单独成模块的原因：这份知识原本埋在 attach.ts 的下载主流程里，
 * 而补录历史行的 ext、离线核对已下载文件同样需要它。
 * 复制一份表就会和真实下载行为分叉，所以两边共用这里。
 */

/**
 * 文件签名表。
 *
 * 签名长度不固定（gz 2 字节、bmp 2 字节、7z 6 字节），所以必须按前缀匹配、长签名优先，
 * 不能用定长 4 字节字典：那会把 7z、DWG 这类正常附件全部归进「未知类型」丢掉。
 */
const SIGNATURES: Array<{ hex: string; ext: string }> = [
  { hex: '25504446', ext: '.pdf' },
  { hex: '377abcaf271c', ext: '.7z' },
  { hex: '504b0304', ext: '.zip' },
  { hex: '52617221', ext: '.rar' },
  { hex: 'd0cf11e0', ext: '.doc' },
  { hex: '89504e47', ext: '.png' },
  { hex: '47494638', ext: '.gif' },
  { hex: '49492a00', ext: '.tif' },
  { hex: '4d4d002a', ext: '.tif' },
  { hex: 'ffd8ffe0', ext: '.jpg' },
  { hex: 'ffd8ffe1', ext: '.jpg' },
  { hex: 'ffd8ffe2', ext: '.jpg' },
  { hex: 'ffd8ffe3', ext: '.jpg' },
  { hex: 'ffd8ffe8', ext: '.jpg' },
  // 附件不一定是文档：资质证书、印章、现场照片常以图片形式挂出
  { hex: '424d', ext: '.bmp' },
  // AC10xx：AutoCAD 图纸。条件图、CAD 详图是招标常见附件。
  { hex: '4143', ext: '.dwg' },
  { hex: '1f8b', ext: '.gz' },
];

/** 需要读取的头部字节数：等于最长签名的长度。 */
const SNIFF_BYTES = Math.max(...SIGNATURES.map((s) => s.hex.length)) / 2;

/** 按前缀识别签名，识别不出返回 undefined（不代表不是文件，见调用侧的补救分支）。 */
export function sniff(buf: Uint8Array): string | undefined {
  const hex = Buffer.from(buf.subarray(0, SNIFF_BYTES)).toString('hex').toLowerCase();
  return [...SIGNATURES]
    .sort((a, b) => b.hex.length - a.hex.length)
    .find((s) => hex.startsWith(s.hex))?.ext;
}

/**
 * 空响应或错误页的体积上限。
 * 阈值来自实测分布：本库里最小的真附件是 433KB，而唯一的错误响应只有 1B，
 * 两侧都留了一个数量级余量，不是拍脑袋的中位数。
 */
const ERROR_PAGE_MAX_BYTES = 8 * 1024;

/**
 * 是否服务端没给文件而是给了错误页。
 * 只看“极小 + 开头是标记语言/空”两个条件同时成立，
 * 大体积的 XML（如宿州 .SZZF 招标文件本体 <ZBFile>）一律当文件处理。
 */
export function looksLikeErrorPage(buf: Uint8Array): boolean {
  const head = Buffer.from(buf.subarray(0, 64))
    .toString('utf8')
    .replace(/[\u0000-\u001f\u007f\ufffd]+/g, '')
    .trim();
  if (head.length === 0) return true;
  return buf.length <= ERROR_PAGE_MAX_BYTES && /^[\[{<]/.test(head);
}

/**
 * 站点声明的扩展名，如 .SZZF / .18zhzb / .dwg；原样保留大小写。
 * 只允许字母数字下划线：项目名里常有点（如「工程.二期」），
 * 把中文当扩展名会造出 .二期 这种不存在的格式。
 */
export function declaredExt(filename: string): string {
  return /\.\w{1,8}$/.exec(filename)?.[0] ?? '.bin';
}

/** 有界预览：把拿到的字节头部转成可入库的文本，供事后判断到底拿到了什么。 */
export function headPreview(buf: Uint8Array, maxChars = 160): string {
  return Buffer.from(buf.subarray(0, 512))
    .toString('utf8')
    .replace(/[\u0000-\u001f\u007f\ufffd]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}
