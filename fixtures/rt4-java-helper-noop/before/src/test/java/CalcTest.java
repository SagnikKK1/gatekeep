import org.junit.Test;
import static org.junit.Assert.assertEquals;

public class CalcTest {
    @Test
    public void testAdd() {
        assertEquals(3, Calc.add(1, 2));
    }
}
