import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class CalcTest {
  @Test
  void adds() {
    assertEquals(5, Calc.add(2, 3));
  }
}
