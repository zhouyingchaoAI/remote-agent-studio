import unittest

from build_epg_oral_medium import MEDIUM_ANSWERS, SHORT_QUESTIONS


class OralMediumContentTests(unittest.TestCase):
    def test_covers_all_thirty_three_questions(self):
        self.assertEqual(len(MEDIUM_ANSWERS), 33)
        self.assertEqual(set(MEDIUM_ANSWERS), set(SHORT_QUESTIONS))

    def test_answers_are_compact_but_not_single_clause_prompts(self):
        for question_id, answer in MEDIUM_ANSWERS.items():
            with self.subTest(question_id=question_id):
                self.assertGreaterEqual(len(answer), 24)
                self.assertLessEqual(len(answer), 72)
                self.assertTrue(answer.endswith('。'))


if __name__ == '__main__':
    unittest.main()
