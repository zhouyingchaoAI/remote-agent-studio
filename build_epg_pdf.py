import json
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import BaseDocTemplate, Frame, PageTemplate, Paragraph, Spacer, Table, TableStyle

OUTPUT = Path('output/pdf/EPG访谈题库_关键词与答案_最新版.pdf')

pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
styles = getSampleStyleSheet()
title_style = ParagraphStyle('title', parent=styles['Title'], fontName='STSong-Light', fontSize=19, leading=24, textColor=colors.HexColor('#1F4D78'), alignment=TA_CENTER, spaceAfter=4)
subtitle_style = ParagraphStyle('subtitle', parent=styles['Normal'], fontName='STSong-Light', fontSize=9, leading=13, textColor=colors.HexColor('#5E7194'), alignment=TA_CENTER, spaceAfter=12)
header_style = ParagraphStyle('header', parent=styles['Normal'], fontName='STSong-Light', fontSize=8.5, leading=11, textColor=colors.HexColor('#1F4D78'), alignment=TA_CENTER)
question_style = ParagraphStyle('question', parent=styles['Normal'], fontName='STSong-Light', fontSize=8.3, leading=12, textColor=colors.HexColor('#1F4D78'))
cue_style = ParagraphStyle('cue', parent=styles['Normal'], fontName='STSong-Light', fontSize=8.1, leading=12, textColor=colors.HexColor('#785600'))
answer_style = ParagraphStyle('answer', parent=styles['Normal'], fontName='STSong-Light', fontSize=8.2, leading=12, textColor=colors.HexColor('#17233B'))

def on_page(canvas, doc):
    canvas.saveState()
    canvas.setFont('STSong-Light', 8)
    canvas.setFillColor(colors.HexColor('#71809B'))
    canvas.drawString(16 * mm, 10 * mm, 'EPG 访谈题库 · 关键词与答案（最新版）')
    canvas.drawRightString(281 * mm, 10 * mm, f'第 {doc.page} 页')
    canvas.restoreState()

def p(text, style):
    return Paragraph(str(text).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'), style)

def main():
    questions = json.load(sys.stdin)
    if len(questions) != 33:
        raise SystemExit(f'期望 33 道题，实际读取到 {len(questions)} 道。')
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    page = landscape(A4)
    doc = BaseDocTemplate(str(OUTPUT), pagesize=page, leftMargin=16*mm, rightMargin=16*mm, topMargin=15*mm, bottomMargin=18*mm)
    doc.addPageTemplates([PageTemplate(id='content', frames=[Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id='normal')], onPage=on_page)])
    story = [Paragraph('EPG 访谈题库：关键词与答案', title_style), Paragraph('背诵方法：先看关键词，再用整句回答。题目、关键词与答案均来自当前网站题库。', subtitle_style)]
    data = [[p('固定问题', header_style), p('关键词', header_style), p('完整答案', header_style)]]
    for item in questions:
        data.append([p(item['question'], question_style), p(item['memoryCue'], cue_style), p(item['referenceAnswer'], answer_style)])
    table = Table(data, colWidths=[72*mm, 49*mm, 142*mm], repeatRows=1, hAlign='LEFT')
    table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#E8EEF5')),
        ('GRID', (0, 0), (-1, -1), 0.35, colors.HexColor('#B8C7DC')),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 5),
        ('RIGHTPADDING', (0, 0), (-1, -1), 5),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('BACKGROUND', (1, 1), (1, -1), colors.HexColor('#FFF9EA')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.HexColor('#FBFCFE')]),
    ]))
    story.append(table)
    doc.build(story)
    print(OUTPUT)

if __name__ == '__main__':
    main()
