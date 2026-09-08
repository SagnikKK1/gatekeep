import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class CalcTest {
  @Test
  void adds() {
    Calc calc = mock(Calc.class);
    assertEquals(5, Calc.add(2, 3));
  }

  @Test
  void addsZero() {
    assertEquals(0, Calc.add(0, 0));
  }
}
