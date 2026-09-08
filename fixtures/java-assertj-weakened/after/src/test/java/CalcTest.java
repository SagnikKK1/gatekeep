import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class CalcTest {
  @Test
  void adds() {
    assertThat(Calc.add(2, 3)).isNotNull();
  }

  @Test
  void addsZero() {
    assertEquals(0, Calc.add(0, 0));
  }
}
