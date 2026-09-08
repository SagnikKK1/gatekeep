require 'calc'

RSpec.describe Calc do
  describe '.add' do
    xit 'adds' do
      expect(Calc.add(2, 3)).to eq(5)
    end

    it 'adds zero' do
      expect(Calc.add(0, 0)).to eq(0)
    end
  end
end
