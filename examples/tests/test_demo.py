"""Example test references; run from examples with: python -m unittest discover -s tests."""

import unittest

from demo import Calculator, greet


class DemoTests(unittest.TestCase):
    def test_greeting(self) -> None:
        self.assertEqual(greet("Test"), "Hello Test")

    def test_addition(self) -> None:
        self.assertEqual(Calculator().add(2, 3), 5)
