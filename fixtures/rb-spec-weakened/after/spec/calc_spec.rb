require 'calc'

RSpec.describe Calc do
  describe '.add' do
    it 'adds' do
      expect(Calc.add(2, 3)).to be_truthy
    end

    it 'adds zero' do
      expect(Calc.add(0, 0)).to eq(0)
    end
  end
end
