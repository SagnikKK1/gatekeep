require 'calc'

RSpec.describe Calc do
  describe '.add' do
    it 'adds' do
      expect(Calc.add(2, 3)).to eq(5)
    end

    it 'adds zero' do
      expect(Calc.add(0, 0)).to eq(0)
    end

    it 'adds negatives' do
      expect(Calc.add(-1, -1)).to eq(-2)
    end
  end
end
