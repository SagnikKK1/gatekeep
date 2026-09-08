import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class CalcTest {
  @Test
  void adds() {
    assertEquals(5, Calc.add(2, 3));
  }

  @Test
  void addsZero() {
    assertEquals(0, Calc.add(0, 0));
  }

  @Test
  void addsNegative() {
    assertEquals(-2, Calc.add(-1, -1));
  }
}
