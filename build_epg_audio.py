import json
import sys
from pathlib import Path

OUT = Path('output/audio')

SHORT_QUESTIONS = {
    'epg-01': '你在过程改进中负责什么？',
    'epg-02': '公司给你哪些支持？',
    'epg-03': '谁检查过程是否遵循、是否有效？',
    'epg-04': '你怎样完善公司的过程和资产？',
    'epg-05': 'EPG小组由哪些人组成？',
    'epg-06': '怎样找出过程的强项和弱项？',
    'epg-07': '怎样发现后续改进机会？',
    'epg-08': '确定机会后，怎样策划改进？',
    'epg-09': '改进目标怎样关联业务目标？',
    'epg-10': '哪些关键过程最能支撑业务目标？',
    'epg-11': '怎样发现新方法和新工具？',
    'epg-12': '怎样帮助员工参与过程改进？',
    'epg-13': '怎样把新过程部署到项目？',
    'epg-14': '怎样判断改进有没有效果？',
    'epg-15': '模板和工具怎么选？',
    'epg-16': '过程资产怎么决定复用、开发还是采购？',
    'epg-17': '公司资产库怎样建设和维护？',
    'epg-18': '公司的研发过程体系分几层？',
    'epg-19': '过程和资产是怎么开发出来的？',
    'epg-20': '怎样沟通和部署过程资产？',
    'epg-21': '怎样保证过程和组织目标一致？',
    'epg-22': '怎样让员工真正使用过程资产？',
    'epg-23': '裁剪指南怎么制定，依据是什么？',
    'epg-24': '公司的标准工作环境是什么？',
    'epg-25': '项目主要度量哪些目标？',
    'epg-26': '项目度量信息怎么确定？',
    'epg-27': '度量数据怎么收集？',
    'epg-28': '度量数据怎么分析？',
    'epg-29': '度量数据怎么存储？',
    'epg-30': '目标有偏差时怎么纠正？',
    'epg-31': '怎样保证度量数据可靠？',
    'epg-32': '项目数据怎样汇总到组织库？',
    'epg-33': '度量结果怎样传达给全员？',
}

def main():
    questions = json.load(sys.stdin)
    if len(questions) != 33:
        raise SystemExit(f'期望 33 道题，实际读取到 {len(questions)} 道。')
    OUT.mkdir(parents=True, exist_ok=True)
    lines = ['EPG访谈口语化背诵版。每题依次朗读：简化问题、关键词和建议短答。']
    text_rows = ['# EPG 访谈口语化背诵版', '']
    for index, item in enumerate(questions, start=1):
        short_question = SHORT_QUESTIONS[item['id']]
        cue = item['memoryCue'].replace('｜', '，')
        lines += [f'第 {index} 题。', f'问题：{short_question}', f'关键词：{cue}', f'建议回答：{item["shortAnswer"]}', '。']
        text_rows += [f'## 第 {index} 题', f'- 简化问题：{short_question}', f'- 关键词：{item["memoryCue"]}', f'- 短答：{item["shortAnswer"]}', '']
    (OUT / 'EPG访谈口语化背诵稿.txt').write_text('\n'.join(lines), encoding='utf-8')
    (OUT / 'EPG访谈口语化背诵稿.md').write_text('\n'.join(text_rows), encoding='utf-8')
    print(OUT / 'EPG访谈口语化背诵稿.txt')

if __name__ == '__main__':
    main()
