import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class CalcTest {
  @Test
  void adds() {
    assertTrue(Calc.add(2, 3) > 0);
  }

  @Test
  void addsZero() {
    assertEquals(0, Calc.add(0, 0));
  }
}
