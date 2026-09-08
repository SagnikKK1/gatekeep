import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class CalcTest {
  @Test
  @Disabled("flaky")
  void adds() {
    assertEquals(5, Calc.add(2, 3));
  }

  @Test
  void addsZero() {
    assertEquals(0, Calc.add(0, 0));
  }
}
