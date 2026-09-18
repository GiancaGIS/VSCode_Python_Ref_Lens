class Calculator:
    def add(self, a: int, b: int) -> int:
        return a + b

    def unused_method(self) -> None:
        print("Nobody calls me")


class VerboseCalculator(Calculator):
    def add(self, a: int, b: int) -> int:
        result = super().add(a, b)
        print(f"Total: {result}")
        return result


def greet(name: str) -> str:
    return f"Hello {name}"


def main() -> None:
    calc = Calculator()
    print(calc.add(2, 3))
    print(calc.add(10, 20))
    print(greet("Gianca"))


if __name__ == "__main__":
    main()
