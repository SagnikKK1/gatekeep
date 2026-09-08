require 'calc'

RSpec.describe Calc do
  describe '.add' do
    it 'adds' do
      expect(Calc.add(2, 3)).to eq(5)
    end
  end
end
