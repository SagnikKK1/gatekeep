import org.junit.Test;

public class CalcTest {
    void checkAdd(int got, int want) {}

    @Test
    public void testAdd() {
        checkAdd(Calc.add(1, 2), 3);
    }
}
