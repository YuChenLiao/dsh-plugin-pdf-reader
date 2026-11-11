"""生成指标校准用的合成样本：无文本层的图像页 PDF（Pillow 只能存图像，不能存文本层）。

文本样本用等宽排版的真实中文段落（多页、含标题与表格行）；
扫描件样本把文字画进位图再存为 PDF，页面上没有任何文本层，用于验证 image_only_hint。
"""
import pathlib
import random

from PIL import Image, ImageDraw, ImageFont

OUT = pathlib.Path("fixtures/samples")
FONT_CJK = "C:/Windows/Fonts/msyh.ttc"
FONT_LATIN = "C:/Windows/Fonts/arial.ttf"
FONT_MONO = "C:/Consolas/consola.ttf"

CN_PARAGRAPH = (
    "本报告说明系统在双栏排版下的阅读顺序恢复能力。段落合并依赖行间距与缩进特征，"
    "跨栏的行不应被拼接为同一段落。表格区域需要独立的单元格切分，避免把边框当成正文。"
    "对于中英混排的文档，标点周围的空格插入策略会直接影响字符统计结果。"
)
EN_PARAGRAPH = (
    "Reading order recovery depends on the geometric layout of text blocks. "
    "A two column page must not interleave lines from different columns, and a "
    "table must be segmented into cells instead of being flattened into prose."
)


def write_text_pdf(path: pathlib.Path, pages: int, cjk: bool, with_table: bool) -> None:
    font = ImageFont.truetype(FONT_CJK if cjk else FONT_LATIN, 18)
    images = []
    for page_no in range(1, pages + 1):
        image = Image.new("RGB", (1240, 1754), "white")
        draw = ImageDraw.Draw(image)
        y = 90
        draw.text((90, y), f"第 {page_no} 页 / Page {page_no}", font=font, fill="black")
        y += 50
        paragraph = CN_PARAGRAPH if cjk else EN_PARAGRAPH
        for line_no in range(18):
            text = paragraph[(line_no * 40) % max(1, len(paragraph) - 40):][:40]
            draw.text((90, y), text if cjk else f"Line {line_no}: {text}", font=font, fill="black")
            y += 34
        if with_table and page_no == 1:
            y += 20
            draw.text((90, y), "指标 | 数值 | 说明" if cjk else "metric | value | note", font=font, fill="black")
            for row in range(1, 6):
                y += 30
                draw.text((90, y), f"row {row} | {row * 17} | sample", font=font, fill="black")
        images.append(image)
    images[0].save(path, save_all=True, append_images=images[1:], resolution=150.0)


def write_scanned_pdf(path: pathlib.Path, pages: int) -> None:
    """把文字画进位图再存 PDF：页面上没有文本层，fast 模式只能拿到空内容。"""
    font = ImageFont.truetype(FONT_CJK, 26)
    images = []
    for page_no in range(1, pages + 1):
        image = Image.new("RGB", (1240, 1754), (250, 250, 248))
        draw = ImageDraw.Draw(image)
        draw.text((80, 80), f"扫描件 第 {page_no} 页", font=font, fill=(20, 20, 20))
        y = 160
        for line in range(26):
            draw.text((80, y), CN_PARAGRAPH[(line * 18) % len(CN_PARAGRAPH):][:22], font=font, fill=(30, 30, 30))
            y += 52
        # 模拟扫描噪点
        for _ in range(4000):
            x = random.randrange(image.width)
            yy = random.randrange(image.height)
            shade = random.randrange(200, 245)
            draw.point((x, yy), fill=(shade, shade, shade))
        images.append(image)
    images[0].save(path, save_all=True, append_images=images[1:], resolution=150.0)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    random.seed(20261111)
    write_text_pdf(OUT / "imgpage-1p.pdf", 1, cjk=True, with_table=False)
    write_text_pdf(OUT / "imgpage-4p.pdf", 4, cjk=True, with_table=True)
    write_text_pdf(OUT / "imgpage-12p.pdf", 12, cjk=True, with_table=True)
    write_text_pdf(OUT / "imgpage-40p.pdf", 40, cjk=True, with_table=False)
    write_text_pdf(OUT / "imgpage-3p.pdf", 3, cjk=False, with_table=False)
    write_text_pdf(OUT / "imgpage-20p.pdf", 20, cjk=False, with_table=True)
    write_scanned_pdf(OUT / "scan-1p.pdf", 1)
    write_scanned_pdf(OUT / "scan-3p.pdf", 3)
    write_scanned_pdf(OUT / "scan-8p.pdf", 8)
    write_scanned_pdf(OUT / "scan-15p.pdf", 15)
    for item in sorted(OUT.glob("*.pdf")):
        print(f"{item.name}\t{item.stat().st_size}")


if __name__ == "__main__":
    main()
