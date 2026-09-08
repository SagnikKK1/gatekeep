import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import static org.junit.jupiter.api.Assertions.*;

class CalcTest {
  @ParameterizedTest
  @CsvSource({"2, 3, 5", "0, 0, 0"})
  void adds(int a, int b, int want) {
    assertEquals(want, Calc.add(a, b));
  }
}
